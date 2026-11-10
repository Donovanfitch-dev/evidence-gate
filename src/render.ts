import type { Report, RequirementResult } from "./types.js";

const NEXT_STEP: Partial<Record<RequirementResult["reason"], string>> = {
  MISSING: "collect this evidence for the revision",
  EXPIRED: "re-run the check; the last observation is too old to rely on",
  WRONG_REVISION: "run the check against this exact revision",
  CONFLICT: "sources disagree; resolve the disagreement before deciding",
  INSUFFICIENT_ACTORS: "another distinct actor must supply passing evidence",
  FAILED: "fix the failure, or record an explicit time-boxed waiver",
};

/** Human-readable report. The JSON report is the stable interface; this is for people. */
export function renderText(report: Report): string {
  const lines: string[] = [];
  const width = Math.max(...report.requirements.map((r) => r.id.length));
  lines.push(`policy    ${report.policy}`);
  lines.push(`revision  ${report.revision}`);
  lines.push(`as of     ${report.evaluatedAt}`);
  lines.push("");
  lines.push(`VERDICT   ${report.verdict}${report.waived ? "  (depends on a waiver)" : ""}`);
  lines.push("");
  for (const r of report.requirements) {
    const advisory = report.advisory.includes(r.id) ? "  [advisory]" : "";
    lines.push(`  ${r.state.padEnd(7)}  ${r.id.padEnd(width)}  ${r.reason}${advisory}`);
    lines.push(`  ${" ".repeat(7)}  ${" ".repeat(width)}  ${r.explanation}`);
  }
  const open = report.requirements.filter((r) => r.state !== "met" && !report.advisory.includes(r.id));
  // A GO verdict needs nothing further, even if some branch of an `any` is still unknown.
  if (report.verdict !== "GO" && open.length > 0) {
    lines.push("");
    lines.push("To settle it:");
    for (const r of open) lines.push(`  - ${r.id}: ${NEXT_STEP[r.reason] ?? r.explanation}`);
  }
  lines.push("");
  lines.push(`inputs sha256  ${report.inputsDigest}`);
  return lines.join("\n");
}
