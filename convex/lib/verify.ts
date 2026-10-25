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

// True if `n` is written in `text`, e.g. 18500 in "$18,500" or 2.5 in "2.5 acres".
export function numberAppears(n: number, text: string): boolean {
  const plain = text.replace(/(\d),(?=\d{3})/g, "$1");
  const re = new RegExp(`(^|[^\\d.])${String(n).replace(".", "\\.")}(?![\\d]|\\.\\d)`);
  return re.test(plain);
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
