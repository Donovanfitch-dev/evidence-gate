import { createHash } from "node:crypto";
import { all, any, not, type Tri } from "./tri.js";
import type {
  Evidence,
  GateExpr,
  Policy,
  ReasonCode,
  Report,
  Requirement,
  RequirementResult,
  Verdict,
  Waiver,
} from "./types.js";

export interface EvaluateInput {
  policy: Policy;
  evidence: readonly Evidence[];
  waivers?: readonly Waiver[];
  /** The exact revision being judged. Evidence about any other revision is not evidence. */
  revision: string;
  /** Injected, never read from the system clock, so evaluation is reproducible. */
  now: Date;
  /** Tolerated clock disagreement before a record counts as future-dated. Default 300. */
  clockSkewSeconds?: number;
}

type Ignored = RequirementResult["ignored"];

function isNewer(a: Evidence, b: Evidence): boolean {
  const ta = Date.parse(a.observedAt);
  const tb = Date.parse(b.observedAt);
  // Ties are broken by id so the outcome never depends on input order.
  return ta === tb ? a.id > b.id : ta > tb;
}

function ids(items: readonly Evidence[]): string[] {
  return items.map((e) => e.id).sort();
}

interface Assessment {
  state: Tri;
  reason: ReasonCode;
  explanation: string;
  basis: string[];
  ignored: Ignored;
}

function assess(req: Requirement, evidence: readonly Evidence[], revision: string, nowMs: number, skewMs: number): Assessment {
  const ignored: Ignored = [];
  const usable: Evidence[] = [];

  for (const item of evidence) {
    if (item.kind !== req.kind) continue;
    if (item.revision !== revision) {
      ignored.push({ id: item.id, why: "other-revision" });
      continue;
    }
    const observed = Date.parse(item.observedAt);
    if (observed > nowMs + skewMs) {
      ignored.push({ id: item.id, why: "future-dated" });
      continue;
    }
    if (req.maxAgeMinutes !== undefined && nowMs - observed > req.maxAgeMinutes * 60_000) {
      ignored.push({ id: item.id, why: "expired" });
      continue;
    }
    usable.push(item);
  }

  // A source speaks with its most recent observation: a re-run supersedes the run before it.
  const latest = new Map<string, Evidence>();
  for (const item of usable) {
    const key = `${item.source}\u0000${item.actor ?? ""}`;
    const current = latest.get(key);
    if (current === undefined) {
      latest.set(key, item);
    } else if (isNewer(item, current)) {
      ignored.push({ id: current.id, why: "superseded" });
      latest.set(key, item);
    } else {
      ignored.push({ id: item.id, why: "superseded" });
    }
  }
  ignored.sort((a, b) => a.id.localeCompare(b.id));

  const current = [...latest.values()];
  const passes = current.filter((e) => e.outcome === "pass");
  const fails = current.filter((e) => e.outcome === "fail");
  const done = (state: Tri, reason: ReasonCode, explanation: string, basis: readonly Evidence[]): Assessment => ({
    state,
    reason,
    explanation,
    basis: ids(basis),
    ignored,
  });

  if (passes.length > 0 && fails.length > 0) {
    // Different sources disagree about the same revision. Picking a winner would be a guess.
    return done(
      req.onConflict ?? "unknown",
      "CONFLICT",
      `${passes.length} source(s) report pass and ${fails.length} report fail for ${revision}`,
      current,
    );
  }
  if (fails.length > 0) {
    return done("unmet", "FAILED", `latest observation from ${fails.map((e) => e.source).sort().join(", ")} is a failure`, fails);
  }

  const nothingUsable = (): Assessment => {
    if (ignored.some((i) => i.why === "expired")) {
      return done("unknown", "EXPIRED", `the only \`${req.kind}\` evidence for ${revision} is older than ${req.maxAgeMinutes} min`, []);
    }
    if (ignored.some((i) => i.why === "other-revision")) {
      return done("unknown", "WRONG_REVISION", `\`${req.kind}\` evidence exists, but none of it is about ${revision}`, []);
    }
    return done("unknown", "MISSING", `no \`${req.kind}\` evidence for ${revision}`, []);
  };

  if (req.minDistinctActors !== undefined) {
    const actors = new Set(passes.flatMap((e) => (e.actor === undefined ? [] : [e.actor])));
    if (actors.size >= req.minDistinctActors) {
      return done("met", "PASSED", `${actors.size} distinct actor(s): ${[...actors].sort().join(", ")}`, passes);
    }
    if (passes.length === 0) return nothingUsable();
    return done("unknown", "INSUFFICIENT_ACTORS", `${actors.size} of ${req.minDistinctActors} required distinct actors`, passes);
  }

  if (passes.length > 0) {
    return done("met", "PASSED", `passing observation from ${passes.map((e) => e.source).sort().join(", ")}`, passes);
  }
  return nothingUsable();
}

function evalGate(expr: GateExpr, states: ReadonlyMap<string, Tri>): Tri {
  if ("req" in expr) return states.get(expr.req) ?? "unknown";
  if ("all" in expr) return all(expr.all.map((e) => evalGate(e, states)));
  if ("any" in expr) return any(expr.any.map((e) => evalGate(e, states)));
  return not(evalGate(expr.not, states));
}

function referenced(expr: GateExpr, into = new Set<string>()): Set<string> {
  if ("req" in expr) into.add(expr.req);
  else if ("all" in expr) expr.all.forEach((e) => referenced(e, into));
  else if ("any" in expr) expr.any.forEach((e) => referenced(e, into));
  else referenced(expr.not, into);
  return into;
}

const VERDICT: Record<Tri, Verdict> = { met: "GO", unmet: "NO_GO", unknown: "UNDETERMINED" };

/** JSON with sorted keys, so equal inputs always hash equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evaluate(input: EvaluateInput): Report {
  const { policy, evidence, revision, now } = input;
  const waivers = input.waivers ?? [];
  const nowMs = now.getTime();
  const skewMs = (input.clockSkewSeconds ?? 300) * 1000;

  const results: RequirementResult[] = policy.requirements.map((req) => {
    const assessment = assess(req, evidence, revision, nowMs, skewMs);
    const result: RequirementResult = {
      id: req.id,
      description: req.description,
      state: assessment.state,
      evidenceState: assessment.state,
      reason: assessment.reason,
      explanation: assessment.explanation,
      basis: assessment.basis,
      ignored: assessment.ignored,
    };
    const waiver = waivers.find(
      (w) => w.requirementId === req.id && w.revision === revision && Date.parse(w.expiresAt) > nowMs,
    );
    // A waiver never hides what the evidence says; it only changes what the gate does about it.
    if (waiver !== undefined && assessment.state !== "met") {
      result.state = "met";
      result.reason = "WAIVED";
      result.explanation = `waived by ${waiver.approvedBy} until ${waiver.expiresAt} (evidence alone: ${assessment.state}, ${assessment.explanation})`;
      result.waiver = { approvedBy: waiver.approvedBy, reason: waiver.reason, expiresAt: waiver.expiresAt };
    }
    return result;
  });

  const gated = new Map(results.map((r) => [r.id, r.state]));
  const unwaived = new Map(results.map((r) => [r.id, r.evidenceState]));
  const verdict = VERDICT[evalGate(policy.gate, gated)];
  const inGate = referenced(policy.gate);

  const digestInput = {
    policy,
    revision,
    evidence: [...evidence].sort((a, b) => a.id.localeCompare(b.id)),
    waivers: [...waivers].sort((a, b) => canonical(a).localeCompare(canonical(b))),
  };

  return {
    policy: policy.name,
    revision,
    evaluatedAt: now.toISOString(),
    verdict,
    waived: verdict !== VERDICT[evalGate(policy.gate, unwaived)],
    requirements: results,
    advisory: policy.requirements.filter((r) => !inGate.has(r.id)).map((r) => r.id),
    inputsDigest: createHash("sha256").update(canonical(digestInput)).digest("hex"),
  };
}
