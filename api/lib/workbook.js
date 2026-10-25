// Turns an uploaded workbook (.xlsx or .csv) into the plain
// `[{ name, rows: [[cell, ...], ...] }]` shape api/lib/financials.js works
// with. Kept separate from financials.js so that module stays dependency-
// free and fast to unit test; this one is the only file that touches
// ExcelJS. ExcelJS (not the `xlsx`/SheetJS package) is used on purpose: at
// the time this was written, SheetJS's last npm-published build had an
// unpatched high-severity prototype-pollution advisory
// (GHSA-4r6h-8v6p-xvw6) and this route parses files anyone can upload, so
// that risk isn't worth taking here.
//
// Legacy .xls (the pre-2007 binary format) isn't supported -- ExcelJS only
// reads the zip-based .xlsx format plus .csv. readWorkbookSheets throws
// UNSUPPORTED_FORMAT for anything else; the caller turns that into a
// friendly "re-export as .xlsx or .csv" message.

import ExcelJS from "exceljs";
import { Readable } from "node:stream";

function cellToPrimitive(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join("");
    if ("result" in value) return value.result === null || value.result === undefined ? "" : value.result; // formula cell
    if ("text" in value) return value.text; // hyperlink cell
    return "";
  }
  return value; // string | number | boolean
}

function worksheetToRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellToPrimitive(cell.value)));
    while (cells.length && (cells[cells.length - 1] === "" || cells[cells.length - 1] === null)) cells.pop();
    rows.push(cells);
  });
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

// .xlsx files are zip archives, which always start with the "PK" magic
// bytes; that's a reliable, cheap way to tell a real workbook from a
// mislabeled or legacy file before handing it to ExcelJS.
function looksLikeZip(buf) {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

export async function readWorkbookSheets(buf, fileName) {
  const nameLooksCsv = /\.csv$/i.test(fileName || "");
  const workbook = new ExcelJS.Workbook();

  if (nameLooksCsv && !looksLikeZip(buf)) {
    await workbook.csv.read(Readable.from(buf));
    const ws = workbook.worksheets[0];
    return ws ? [{ name: ws.name || "Sheet1", rows: worksheetToRows(ws) }] : [];
  }

  if (!looksLikeZip(buf)) {
    const err = new Error("Unsupported spreadsheet format");
    err.code = "UNSUPPORTED_FORMAT";
    throw err;
  }

  await workbook.xlsx.load(buf);
  return workbook.worksheets.map((ws) => ({ name: ws.name, rows: worksheetToRows(ws) }));
}
