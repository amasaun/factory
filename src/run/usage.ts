/** Model usage as reported by the model CLI's result output, summed for a run's pull request. */

export interface SessionUsage {
  role: "builder" | "judge";
  attempt: number;
  /** Model names the CLI reported, when it reported any. */
  models: string[];
  /** Estimated spend at list prices, when reported. */
  usd: number | null;
  /** Builder only: sessions used, counting handoffs. */
  sessions?: number;
  /** Builder only: highest context size seen, in tokens. */
  peakContext?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read one result file's usage. Unreadable or missing fields become nulls, never errors. */
export function readUsage(role: SessionUsage["role"], attempt: number, result: unknown): SessionUsage {
  const r = isObject(result) ? result : {};
  const usage: SessionUsage = {
    role,
    attempt,
    models: isObject(r.modelUsage) ? Object.keys(r.modelUsage).slice(0, 5).map((m) => m.replace(/[^A-Za-z0-9._-]/g, "")) : [],
    usd: typeof r.total_cost_usd === "number" && Number.isFinite(r.total_cost_usd) && r.total_cost_usd >= 0 ? r.total_cost_usd : null,
  };
  const f = r.factory;
  if (role === "builder" && isObject(f) && Array.isArray(f.segments)) {
    usage.sessions = f.segments.length;
    const peaks = f.segments.map((s) => (isObject(s) && typeof s.peak === "number" ? s.peak : 0));
    usage.peakContext = peaks.length ? Math.max(...peaks) : undefined;
  }
  return usage;
}

const money = (n: number | null) => (n === null ? "not reported" : `$${n.toFixed(2)}`);

/** Markdown for the pull request. The builder's figures come from a worker job, so they are labelled as reported. */
export function usageSection(sessions: SessionUsage[]): string {
  if (sessions.length === 0) return "No usage was reported.";
  const rows = sessions.map((s) => {
    const detail =
      s.role === "builder" && s.sessions !== undefined
        ? `${s.sessions} session(s), peak context ${s.peakContext ?? 0} tokens`
        : "";
    return `| ${s.attempt} | ${s.role} | ${s.models.map((m) => `\`${m}\``).join(", ") || "not reported"} | ${money(s.usd)} | ${detail} |`;
  });
  const known = sessions.filter((s) => s.usd !== null);
  const total = known.reduce((n, s) => n + (s.usd as number), 0);
  return [
    "| Attempt | Role | Model | Estimated spend | Notes |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `Total reported: ${money(known.length ? total : null)}${known.length < sessions.length ? " (some sessions did not report)" : ""}. These are the model CLI's own estimates at list prices. With a subscription credential they count against the plan's limits and are not billed per use. A builder session that was handed off part-way reports only its final session.`,
  ].join("\n");
}
