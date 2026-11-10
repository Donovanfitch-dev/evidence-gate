import type { Evidence, GateExpr, Policy, Requirement, Waiver } from "./types.js";

/** Raised for any malformed policy, evidence or waiver input. */
export class InputError extends Error {
  override name = "InputError";
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InputError(`${path}: expected an object`);
  return value;
}

function text(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${path}.${key}: expected a non-empty string`);
  }
  return value;
}

function optionalText(obj: Record<string, unknown>, key: string, path: string): string | undefined {
  return obj[key] === undefined ? undefined : text(obj, key, path);
}

function positiveInt(obj: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InputError(`${path}.${key}: expected a positive integer`);
  }
  return value;
}

/** An instant must carry an explicit offset; local times are ambiguous evidence. */
function instant(obj: Record<string, unknown>, key: string, path: string): string {
  const value = text(obj, key, path);
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(`${path}.${key}: expected an ISO-8601 instant with a UTC offset, got "${value}"`);
  }
  return value;
}

function parseRequirement(raw: unknown, path: string): Requirement {
  const obj = record(raw, path);
  const requirement: Requirement = {
    id: text(obj, "id", path),
    description: text(obj, "description", path),
    kind: text(obj, "kind", path),
  };
  const maxAge = positiveInt(obj, "maxAgeMinutes", path);
  if (maxAge !== undefined) requirement.maxAgeMinutes = maxAge;
  const actors = positiveInt(obj, "minDistinctActors", path);
  if (actors !== undefined) requirement.minDistinctActors = actors;
  if (obj["onConflict"] !== undefined) {
    if (obj["onConflict"] !== "unknown" && obj["onConflict"] !== "unmet") {
      throw new InputError(`${path}.onConflict: expected "unknown" or "unmet"`);
    }
    requirement.onConflict = obj["onConflict"];
  }
  return requirement;
}

function parseGate(raw: unknown, path: string, known: ReadonlySet<string>): GateExpr {
  const obj = record(raw, path);
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new InputError(`${path}: expected exactly one of "req", "all", "any", "not"`);
  }
  const key = keys[0];
  if (key === "req") {
    const id = text(obj, "req", path);
    if (!known.has(id)) throw new InputError(`${path}.req: unknown requirement "${id}"`);
    return { req: id };
  }
  if (key === "all" || key === "any") {
    const items = obj[key];
    // An empty conjunction is vacuously true. A gate must never pass by saying nothing.
    if (!Array.isArray(items) || items.length === 0) {
      throw new InputError(`${path}.${key}: expected a non-empty array`);
    }
    const parsed = items.map((item, i) => parseGate(item, `${path}.${key}[${i}]`, known));
    return key === "all" ? { all: parsed } : { any: parsed };
  }
  if (key === "not") return { not: parseGate(obj["not"], `${path}.not`, known) };
  throw new InputError(`${path}: unknown operator "${String(key)}"`);
}

export function parsePolicy(raw: unknown): Policy {
  const obj = record(raw, "policy");
  if (obj["version"] !== 1) throw new InputError("policy.version: only version 1 is supported");
  const rawRequirements = obj["requirements"];
  if (!Array.isArray(rawRequirements) || rawRequirements.length === 0) {
    throw new InputError("policy.requirements: expected a non-empty array");
  }
  const requirements = rawRequirements.map((r, i) => parseRequirement(r, `policy.requirements[${i}]`));
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) {
      throw new InputError(`policy.requirements: duplicate id "${requirement.id}"`);
    }
    ids.add(requirement.id);
  }
  return {
    version: 1,
    name: text(obj, "name", "policy"),
    requirements,
    gate: parseGate(obj["gate"], "policy.gate", ids),
  };
}

export function parseEvidence(raw: unknown, path = "evidence"): Evidence {
  const obj = record(raw, path);
  const outcome = obj["outcome"];
  if (outcome !== "pass" && outcome !== "fail") {
    throw new InputError(`${path}.outcome: expected "pass" or "fail"`);
  }
  const evidence: Evidence = {
    id: text(obj, "id", path),
    kind: text(obj, "kind", path),
    revision: text(obj, "revision", path),
    outcome,
    observedAt: instant(obj, "observedAt", path),
    source: text(obj, "source", path),
  };
  const actor = optionalText(obj, "actor", path);
  if (actor !== undefined) evidence.actor = actor;
  const detail = optionalText(obj, "detail", path);
  if (detail !== undefined) evidence.detail = detail;
  return evidence;
}

export function parseEvidenceList(raw: unknown, path = "evidence"): Evidence[] {
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item, i) => parseEvidence(item, `${path}[${i}]`));
}

/** Evidence ids are how a report cites its basis, so they must be unique. */
export function assertUniqueIds(evidence: readonly Evidence[]): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id)) throw new InputError(`evidence: duplicate id "${item.id}"`);
    seen.add(item.id);
  }
}

export function parseWaivers(raw: unknown): Waiver[] {
  if (!Array.isArray(raw)) throw new InputError("waivers: expected an array");
  return raw.map((item, i) => {
    const path = `waivers[${i}]`;
    const obj = record(item, path);
    return {
      requirementId: text(obj, "requirementId", path),
      revision: text(obj, "revision", path),
      reason: text(obj, "reason", path),
      approvedBy: text(obj, "approvedBy", path),
      expiresAt: instant(obj, "expiresAt", path),
    };
  });
}
