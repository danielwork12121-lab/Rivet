// Reads an environment variable with surrounding whitespace removed, so a value
// pasted with a trailing space or newline (common in dashboards) still works.
// Unset reads as "".
export function env(name) {
  return (process.env[name] ?? "").trim();
}
