/**
 * Turn free text into a URL slug: lower case, words joined by single hyphens,
 * no leading or trailing hyphen.
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
