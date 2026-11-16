/** Count whitespace-separated words. Empty or blank text has zero words. */
export function wordCount(text) {
  const trimmed = String(text).trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
