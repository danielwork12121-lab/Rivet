// Checks that keep the AI honest. A fact extracted from a web page is kept only
// if its quote really appears on that page and contains the number; a number
// read from the operator's message is kept only if the operator wrote it.

// Lower case, markdown symbols and extra spaces removed, curly quotes made plain.
export function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[*_`#>|\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// True if `n` is written in `text`, e.g. 18500 in "$18,500", 2399 in "$2,399.00" or 2.5 in "2.5 acres".
// Trailing zeros after the decimal point are the same number ("2,399.00", "2.50").
export function numberAppears(n: number, text: string): boolean {
  const plain = text.replace(/(\d),(?=\d{3})/g, "$1");
  const digits = String(n).replace(".", "\\.");
  const zeros = Number.isInteger(n) ? "(\\.0+)?" : "0*";
  const re = new RegExp(`(^|[^\\d.])${digits}${zeros}(?![\\d]|\\.\\d)`);
  return re.test(plain) || scaledAppears(n, plain);
}

// Money written the way people type it: "58k", "$58K", "1.2M", "2 million". The operator wrote
// that number, so it counts; nothing is estimated. A bare lower-case "m" ("5 m wide") is a length,
// not millions, so it only counts with a "$" in front ("$1.2m").
const SCALED = /(^|[^\d.])(\$\s?)?(\d+(?:\.\d+)?)\s?(k|thousand|mm|million|m)(?![a-z])/gi;

function scaledAppears(n: number, plain: string): boolean {
  for (const m of plain.matchAll(SCALED)) {
    const [, , dollar, num, unitRaw] = m;
    const unit = unitRaw.toLowerCase();
    let factor: number;
    if (unit === "k" || unit === "thousand") factor = 1e3;
    else if (unit === "mm" || unit === "million") factor = 1e6;
    else if (unitRaw === "M" || dollar) factor = 1e6;
    else continue;
    if (Math.abs(Number(num) * factor - n) < 1e-6) return true;
  }
  return false;
}

export type Evidence = { value: number | null; unit: string | null; quote: string | null };

// Keeps the value only if the quote is on the page and contains the number.
export function verifyEvidence(e: Evidence, pageText: string): Evidence {
  if (e.value === null || !e.quote) return { ...e, value: null };
  const onPage = squash(pageText).includes(squash(e.quote));
  return onPage && numberAppears(e.value, e.quote) ? e : { ...e, value: null };
}

// Finds "$12,000" and "9 months" in a sentence.
export function numbersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\$\s?([\d,]+)|(\d+)\s*months?/g)) {
    found.push((m[1] ?? m[2]).replace(/,/g, ""));
  }
  return found;
}
