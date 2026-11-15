import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, no whitespace. Two values that are
 * structurally equal always produce the same text, so digests are stable
 * regardless of key order in the source document.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number cannot be canonicalized");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`${typeof value} cannot be canonicalized`);
  }
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}
