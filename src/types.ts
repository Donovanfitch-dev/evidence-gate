import type { Tri } from "./tri.js";

/** One observation about one revision, reported by one source. */
export interface Evidence {
  /** Unique id of this record. */
  id: string;
  /** What was observed, e.g. `ci.tests` or `review.approval`. */
  kind: string;
  /** The exact revision the observation is about. */
  revision: string;
  outcome: "pass" | "fail";
  /** ISO-8601 instant at which the observation was made. */
  observedAt: string;
  /** The system that produced the record, e.g. `ci/main-pipeline`. */
  source: string;
  /** The person or identity behind the record, when that matters (reviews). */
  actor?: string;
  detail?: string;
}

export interface Requirement {
  id: string;
  description: string;
  /** Evidence kind that can meet this requirement. */
  kind: string;
  /** Evidence older than this is ignored. Omit for "never expires". */
  maxAgeMinutes?: number;
  /** Require passing evidence from at least this many distinct actors. */
  minDistinctActors?: number;
  /** What disagreeing sources mean. Defaults to `unknown`. */
  onConflict?: "unknown" | "unmet";
}

export type GateExpr =
  | { req: string }
  | { all: GateExpr[] }
  | { any: GateExpr[] }
  | { not: GateExpr };

export interface Policy {
  version: 1;
  name: string;
  requirements: Requirement[];
  /** Boolean structure over requirement ids, evaluated in three-valued logic. */
  gate: GateExpr;
}

/** An explicit, time-boxed, revision-bound acceptance of risk. */
export interface Waiver {
  requirementId: string;
  revision: string;
  reason: string;
  approvedBy: string;
  expiresAt: string;
}

export type ReasonCode =
  | "PASSED"
  | "FAILED"
  | "MISSING"
  | "EXPIRED"
  | "WRONG_REVISION"
  | "CONFLICT"
  | "INSUFFICIENT_ACTORS"
  | "WAIVED";

export interface RequirementResult {
  id: string;
  description: string;
  /** State used by the gate (after any waiver). */
  state: Tri;
  /** State the evidence alone supports (before any waiver). */
  evidenceState: Tri;
  reason: ReasonCode;
  explanation: string;
  /** Ids of the evidence records the state rests on. */
  basis: string[];
  /** Ids of records that matched the kind but were set aside, with why. */
  ignored: { id: string; why: "expired" | "superseded" | "other-revision" | "future-dated" }[];
  waiver?: { approvedBy: string; reason: string; expiresAt: string };
}

export type Verdict = "GO" | "NO_GO" | "UNDETERMINED";

export interface Report {
  policy: string;
  revision: string;
  evaluatedAt: string;
  verdict: Verdict;
  /** True when the verdict depends on at least one waiver. */
  waived: boolean;
  requirements: RequirementResult[];
  /** Requirement ids that the gate does not reference; reported, never decisive. */
  advisory: string[];
  /** SHA-256 over the canonical inputs, so a verdict can be reproduced. */
  inputsDigest: string;
}
