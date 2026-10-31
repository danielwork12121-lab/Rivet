// Reads a Convex environment variable with surrounding whitespace removed, so a value
// pasted with a trailing space or newline still works. Unset reads as "".
export function env(name: string): string {
  return (process.env[name] ?? "").trim();
}
