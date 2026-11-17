/**
 * Minimal Jira Cloud client for the trusted side: read a ticket, find who
 * added a label, move it to a status, comment on it, and remove a label.
 */
import type { AdfNode } from "./adf.ts";

export class JiraError extends Error {
  override name = "JiraError";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface JiraOptions {
  /** Site address, such as https://example.atlassian.net */
  baseUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export interface JiraPerson {
  accountId: string;
  email: string | null;
  name: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  /** The description as ADF, or null when empty. */
  description: unknown;
  labels: string[];
  status: string;
  url: string;
  /** Label changes, oldest first. */
  labelChanges: { by: JiraPerson; added: string[]; removed: string[] }[];
}

const KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,8}$/;
export const isJiraKey = (s: string): boolean => KEY.test(s);

export class Jira {
  #base: string;
  #auth: string;
  #fetch: typeof fetch;

  constructor(o: JiraOptions) {
    const url = new URL(o.baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") throw new TypeError("the Jira address must use https");
    if (!o.email || !o.apiToken) throw new TypeError("a Jira email and API token are required");
    this.#base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    this.#auth = `Basic ${Buffer.from(`${o.email}:${o.apiToken}`).toString("base64")}`;
    this.#fetch = o.fetch ?? fetch;
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}/rest/api/3${path}`, {
      method,
      headers: { authorization: this.#auth, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { errorMessages?: string[]; message?: string };
        detail = j.errorMessages?.join("; ") || j.message || "";
      } catch {
        // No JSON body; the status is enough.
      }
      throw new JiraError(res.status, `Jira ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res.status === 204 ? null : res.json();
  }

  #key(key: string): string {
    if (!isJiraKey(key)) throw new TypeError(`'${key}' is not a Jira ticket key`);
    return key;
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = (await this.#request("GET", `/issue/${this.#key(key)}?fields=summary,description,labels,status&expand=changelog`)) as {
      key: string;
      fields: { summary?: string; description?: unknown; labels?: string[]; status?: { name?: string } };
      changelog?: { histories?: { created: string; author?: { accountId?: string; emailAddress?: string; displayName?: string }; items?: { field?: string; fromString?: string | null; toString?: string | null }[] }[] };
    };
    const words = (s: string | null | undefined) => (s ?? "").split(/\s+/).filter(Boolean);
    const labelChanges = (raw.changelog?.histories ?? [])
      .slice()
      .sort((a, b) => a.created.localeCompare(b.created))
      .flatMap((h) =>
        (h.items ?? [])
          .filter((i) => i.field === "labels")
          .map((i) => {
            const before = new Set(words(i.fromString));
            // `toString` is a real field here, not the method: read it as data.
            const after = new Set(words(Object.hasOwn(i, "toString") ? (i.toString as unknown as string | null) : ""));
            return {
              by: { accountId: h.author?.accountId ?? "", email: h.author?.emailAddress ?? null, name: h.author?.displayName ?? "" },
              added: [...after].filter((l) => !before.has(l)),
              removed: [...before].filter((l) => !after.has(l)),
            };
          }),
      );
    return {
      key: raw.key,
      summary: raw.fields.summary ?? "",
      description: raw.fields.description ?? null,
      labels: raw.fields.labels ?? [],
      status: raw.fields.status?.name ?? "",
      url: `${this.#base}/browse/${raw.key}`,
      labelChanges,
    };
  }

  /**
   * Move a ticket to a status by the status's name. Jira names transitions
   * separately from the statuses they lead to, and which ones exist depends on
   * where the ticket is now, so this asks Jira what is possible and picks the
   * transition that ends in the wanted status.
   *
   * Returns `moved`, `already` when the ticket is in that status, or
   * `unavailable` when the workflow has no such move from where the ticket is.
   */
  async moveTo(key: string, status: string, current: string): Promise<"moved" | "already" | "unavailable"> {
    const want = status.trim().toLowerCase();
    if (current.trim().toLowerCase() === want) return "already";
    const raw = (await this.#request("GET", `/issue/${this.#key(key)}/transitions`)) as { transitions?: { id: string; to?: { name?: string } }[] };
    const match = (raw.transitions ?? []).find((t) => (t.to?.name ?? "").trim().toLowerCase() === want);
    if (!match) return "unavailable";
    await this.#request("POST", `/issue/${key}/transitions`, { transition: { id: match.id } });
    return "moved";
  }

  async comment(key: string, body: AdfNode): Promise<void> {
    await this.#request("POST", `/issue/${this.#key(key)}/comment`, { body });
  }

  async removeLabel(key: string, label: string): Promise<void> {
    await this.#request("PUT", `/issue/${this.#key(key)}`, { update: { labels: [{ remove: label }] } });
  }
}

/** Who most recently added a label that is still on the ticket, or null if the history does not say. */
export function labelAddedBy(issue: JiraIssue, label: string): JiraPerson | null {
  for (const change of issue.labelChanges.slice().reverse()) {
    if (change.added.includes(label)) return change.by;
    if (change.removed.includes(label)) return null;
  }
  return null;
}

/** Whether a person is on a list of approvers given as account ids or email addresses. */
export function isJiraApprover(person: JiraPerson, approvers: readonly string[]): boolean {
  const wanted = new Set(approvers.map((a) => a.trim().toLowerCase()));
  return (person.accountId !== "" && wanted.has(person.accountId.toLowerCase())) || (person.email !== null && wanted.has(person.email.toLowerCase()));
}
