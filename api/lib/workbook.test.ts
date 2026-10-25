import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readWorkbookSheets } from "./workbook.js";

async function buildXlsxBuffer() {
  const wb = new ExcelJS.Workbook();
  const pl = wb.addWorksheet("P&L");
  pl.addRow(["Revenue", 1200000]);
  pl.addRow(["COGS", 700000]);
  const jobs = wb.addWorksheet("Jobs");
  jobs.addRow(["Process", "Annual cost"]);
  jobs.addRow(["Mowing crew", 180000]);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe("readWorkbookSheets", () => {
  it("reads every sheet of a real .xlsx workbook, in order, as row arrays", async () => {
    const buf = await buildXlsxBuffer();
    const sheets = await readWorkbookSheets(buf, "financials.xlsx");
    expect(sheets.map((s) => s.name)).toEqual(["P&L", "Jobs"]);
    expect(sheets[0].rows).toEqual([
      ["Revenue", 1200000],
      ["COGS", 700000],
    ]);
    expect(sheets[1].rows[1]).toEqual(["Mowing crew", 180000]);
  });

  it("reads a .csv file as a single sheet", async () => {
    const csv = Buffer.from("Process,Annual cost\nMowing crew,180000\n", "utf8");
    const sheets = await readWorkbookSheets(csv, "financials.csv");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows[0]).toEqual(["Process", "Annual cost"]);
    // ExcelJS's CSV reader does its own type inference, so a numeric-looking
    // cell comes back as a number here too, same as from a real .xlsx sheet.
    expect(sheets[0].rows[1]).toEqual(["Mowing crew", 180000]);
  });

  it("rejects a file that is neither a real workbook nor a csv", async () => {
    const junk = Buffer.from("not a spreadsheet at all");
    await expect(readWorkbookSheets(junk, "financials.xlsx")).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });
});
