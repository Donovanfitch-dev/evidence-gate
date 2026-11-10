import { describe, expect, it } from "vitest";
import { assertUniqueIds, InputError, parseEvidence, parsePolicy, parseWaivers } from "../src/validate.js";

const requirement = { id: "r", description: "d", kind: "ci.tests" };
const policy = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: "p",
  requirements: [requirement],
  gate: { req: "r" },
  ...overrides,
});
const evidence = (overrides: Record<string, unknown> = {}) => ({
  id: "e1",
  kind: "ci.tests",
  revision: "4be1c02",
  outcome: "pass",
  observedAt: "2026-03-02T11:00:00Z",
  source: "ci/main-pipeline",
  ...overrides,
});

describe("parsePolicy", () => {
  it("accepts a minimal policy", () => {
    expect(parsePolicy(policy()).name).toBe("p");
  });

  it.each([
    ["an unsupported version", policy({ version: 2 }), /version/],
    ["no requirements", policy({ requirements: [] }), /non-empty/],
    ["duplicate requirement ids", policy({ requirements: [requirement, requirement] }), /duplicate id "r"/],
    ["a gate that names an unknown requirement", policy({ gate: { req: "nope" } }), /unknown requirement "nope"/],
    ["an empty `all`, which would pass vacuously", policy({ gate: { all: [] } }), /non-empty/],
    ["an empty `any`", policy({ gate: { any: [] } }), /non-empty/],
    ["an unknown operator", policy({ gate: { xor: [] } }), /unknown operator/],
    ["a gate node with two operators", policy({ gate: { req: "r", not: { req: "r" } } }), /exactly one/],
    ["a non-integer max age", policy({ requirements: [{ ...requirement, maxAgeMinutes: 1.5 }] }), /positive integer/],
    ["a zero actor count", policy({ requirements: [{ ...requirement, minDistinctActors: 0 }] }), /positive integer/],
    ["an invalid conflict mode", policy({ requirements: [{ ...requirement, onConflict: "pass" }] }), /onConflict/],
    ["a missing gate", policy({ gate: undefined }), /policy\.gate/],
    ["a misspelled requirement key, which would silently drop the rule", policy({ requirements: [{ ...requirement, minDistinctActor: 2 }] }), /unknown key "minDistinctActor"/],
    ["a misspelled freshness key", policy({ requirements: [{ ...requirement, maxAgeMinute: 60 }] }), /unknown key "maxAgeMinute"/],
    ["an unknown top-level key", policy({ gates: { req: "r" } }), /unknown key "gates"/],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => parsePolicy(raw)).toThrow(InputError);
    expect(() => parsePolicy(raw)).toThrow(message);
  });
});

describe("parseEvidence", () => {
  it("accepts a well-formed record and keeps optional fields", () => {
    expect(parseEvidence(evidence({ actor: "ana" }))).toMatchObject({ id: "e1", actor: "ana" });
  });

  it.each([
    ["an outcome other than pass/fail", evidence({ outcome: "skipped" }), /outcome/],
    ["an empty id", evidence({ id: " " }), /\.id/],
    ["a timestamp with no UTC offset", evidence({ observedAt: "2026-03-02T11:00:00" }), /UTC offset/],
    ["a date that is not an instant", evidence({ observedAt: "yesterday" }), /UTC offset/],
    ["a non-object", "pass", /expected an object/],
    ["an unknown key", evidence({ actr: "ana" }), /unknown key "actr"/],
  ])("rejects %s", (_label, raw, message) => {
    expect(() => parseEvidence(raw)).toThrow(message);
  });

  it("rejects duplicate ids across a set", () => {
    const item = parseEvidence(evidence());
    expect(() => assertUniqueIds([item, item])).toThrow(/duplicate id "e1"/);
  });
});

describe("parseWaivers", () => {
  it("requires every field, including who approved it", () => {
    const waiver = { requirementId: "r", revision: "4be1c02", reason: "x", expiresAt: "2026-03-03T00:00:00Z" };
    expect(() => parseWaivers([waiver])).toThrow(/approvedBy/);
    expect(parseWaivers([{ ...waiver, approvedBy: "cy" }])).toHaveLength(1);
  });

  it("rejects unknown keys", () => {
    const waiver = { requirementId: "r", revision: "4be1c02", reason: "x", approvedBy: "cy", expiresAt: "2026-03-03T00:00:00Z" };
    expect(() => parseWaivers([{ ...waiver, expires: "never" }])).toThrow(/unknown key "expires"/);
  });
});
