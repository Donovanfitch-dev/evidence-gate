import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluate.js";
import type { Evidence, Policy, Requirement, Waiver } from "../src/types.js";

const REV = "4be1c02";
const NOW = new Date("2026-03-02T12:00:00Z");

let counter = 0;
function ev(partial: Partial<Evidence> & Pick<Evidence, "kind" | "outcome">): Evidence {
  counter += 1;
  return {
    id: `e${String(counter).padStart(3, "0")}`,
    revision: REV,
    observedAt: "2026-03-02T11:00:00Z",
    source: "ci/main-pipeline",
    ...partial,
  };
}

function single(req: Partial<Requirement> = {}): Policy {
  return {
    version: 1,
    name: "t",
    requirements: [{ id: "r", description: "d", kind: "ci.tests", ...req }],
    gate: { req: "r" },
  };
}

function judge(policy: Policy, evidence: Evidence[], waivers: Waiver[] = []) {
  return evaluate({ policy, evidence, waivers, revision: REV, now: NOW });
}

describe("a single requirement", () => {
  it("is GO on a passing observation of the revision", () => {
    const report = judge(single(), [ev({ kind: "ci.tests", outcome: "pass" })]);
    expect(report.verdict).toBe("GO");
    expect(report.requirements[0]?.reason).toBe("PASSED");
  });

  it("is NO_GO on a failing observation", () => {
    const report = judge(single(), [ev({ kind: "ci.tests", outcome: "fail" })]);
    expect(report.verdict).toBe("NO_GO");
    expect(report.requirements[0]?.reason).toBe("FAILED");
  });

  it("is UNDETERMINED, not NO_GO, when there is no evidence at all", () => {
    const report = judge(single(), []);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.reason).toBe("MISSING");
  });

  it("does not accept evidence about a different revision", () => {
    const report = judge(single(), [ev({ kind: "ci.tests", outcome: "pass", revision: "9d07a3e" })]);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.reason).toBe("WRONG_REVISION");
    expect(report.requirements[0]?.ignored).toEqual([{ id: expect.any(String), why: "other-revision" }]);
  });

  it("ignores evidence older than maxAgeMinutes", () => {
    const old = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T09:00:00Z" });
    const report = judge(single({ maxAgeMinutes: 120 }), [old]);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.reason).toBe("EXPIRED");
  });

  it("an expired failure does not block either: expired means unknown in both directions", () => {
    const old = ev({ kind: "ci.tests", outcome: "fail", observedAt: "2026-03-01T09:00:00Z" });
    expect(judge(single({ maxAgeMinutes: 120 }), [old]).verdict).toBe("UNDETERMINED");
  });

  it("accepts evidence exactly at the age limit", () => {
    const edge = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T10:00:00Z" });
    expect(judge(single({ maxAgeMinutes: 120 }), [edge]).verdict).toBe("GO");
  });

  it("sets aside future-dated evidence beyond the clock-skew allowance", () => {
    const future = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T13:00:00Z" });
    const report = judge(single(), [future]);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.ignored[0]?.why).toBe("future-dated");

    const withinSkew = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T12:03:00Z" });
    expect(judge(single(), [withinSkew]).verdict).toBe("GO");
  });
});

describe("several observations", () => {
  it("lets a source's re-run supersede its earlier result", () => {
    const first = ev({ kind: "ci.tests", outcome: "fail", observedAt: "2026-03-02T09:00:00Z" });
    const rerun = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T09:30:00Z" });
    const report = judge(single(), [first, rerun]);
    expect(report.verdict).toBe("GO");
    expect(report.requirements[0]?.basis).toEqual([rerun.id]);
    expect(report.requirements[0]?.ignored).toEqual([{ id: first.id, why: "superseded" }]);
  });

  it("a later failure from the same source supersedes an earlier pass", () => {
    const first = ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T09:00:00Z" });
    const later = ev({ kind: "ci.tests", outcome: "fail", observedAt: "2026-03-02T09:30:00Z" });
    expect(judge(single(), [first, later]).verdict).toBe("NO_GO");
  });

  it("treats disagreement between sources as unknown by default", () => {
    const a = ev({ kind: "ci.tests", outcome: "pass", source: "ci/main-pipeline" });
    const b = ev({ kind: "ci.tests", outcome: "fail", source: "ci/mirror-pipeline" });
    const report = judge(single(), [a, b]);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.reason).toBe("CONFLICT");
    expect(report.requirements[0]?.basis).toEqual([a.id, b.id].sort());
  });

  it("can be told to fail closed on disagreement", () => {
    const a = ev({ kind: "ci.tests", outcome: "pass", source: "ci/main-pipeline" });
    const b = ev({ kind: "ci.tests", outcome: "fail", source: "ci/mirror-pipeline" });
    expect(judge(single({ onConflict: "unmet" }), [a, b]).verdict).toBe("NO_GO");
  });

  it("does not depend on the order evidence arrives in", () => {
    const items = [
      ev({ kind: "ci.tests", outcome: "fail", observedAt: "2026-03-02T09:00:00Z" }),
      ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T09:30:00Z" }),
      ev({ kind: "ci.tests", outcome: "pass", observedAt: "2026-03-02T09:30:00Z", source: "ci/mirror-pipeline" }),
    ];
    const forward = judge(single(), items);
    const backward = judge(single(), [...items].reverse());
    expect(backward).toEqual(forward);
  });
});

describe("distinct actors", () => {
  const policy = single({ kind: "review.approval", minDistinctActors: 2 });
  const approve = (actor?: string) =>
    ev({ kind: "review.approval", outcome: "pass", source: "code-review", ...(actor ? { actor } : {}) });

  it("needs the required number of different actors", () => {
    expect(judge(policy, [approve("ana"), approve("bo")]).verdict).toBe("GO");
  });

  it("does not count the same actor twice", () => {
    const report = judge(policy, [approve("ana"), approve("ana")]);
    expect(report.verdict).toBe("UNDETERMINED");
    expect(report.requirements[0]?.reason).toBe("INSUFFICIENT_ACTORS");
  });

  it("does not count evidence with no actor", () => {
    expect(judge(policy, [approve("ana"), approve()]).verdict).toBe("UNDETERMINED");
  });

  it("a rejection from any reviewer conflicts with approvals", () => {
    const reject = ev({ kind: "review.approval", outcome: "fail", source: "code-review", actor: "cy" });
    expect(judge(policy, [approve("ana"), approve("bo"), reject]).requirements[0]?.reason).toBe("CONFLICT");
  });
});

describe("gate structure", () => {
  const policy: Policy = {
    version: 1,
    name: "t",
    requirements: [
      { id: "tests", description: "d", kind: "ci.tests" },
      { id: "staging", description: "d", kind: "deploy.staging-health" },
      { id: "canary", description: "d", kind: "deploy.canary-health" },
      { id: "changelog", description: "d", kind: "docs.changelog" },
    ],
    gate: { all: [{ req: "tests" }, { any: [{ req: "staging" }, { req: "canary" }] }] },
  };
  const tests = () => ev({ kind: "ci.tests", outcome: "pass" });

  it("one met branch of `any` is enough even when the other is unknown", () => {
    const report = judge(policy, [tests(), ev({ kind: "deploy.canary-health", outcome: "pass" })]);
    expect(report.verdict).toBe("GO");
  });

  it("one unmet operand in `all` is NO_GO even when other operands are unknown", () => {
    const report = judge(policy, [ev({ kind: "ci.tests", outcome: "fail" })]);
    expect(report.verdict).toBe("NO_GO");
  });

  it("is UNDETERMINED when `any` has one failure and one unknown", () => {
    const report = judge(policy, [tests(), ev({ kind: "deploy.staging-health", outcome: "fail" })]);
    expect(report.verdict).toBe("UNDETERMINED");
  });

  it("reports requirements outside the gate as advisory and never lets them decide", () => {
    const report = judge(policy, [
      tests(),
      ev({ kind: "deploy.canary-health", outcome: "pass" }),
      ev({ kind: "docs.changelog", outcome: "fail" }),
    ]);
    expect(report.advisory).toEqual(["changelog"]);
    expect(report.verdict).toBe("GO");
  });

  it("supports `not`, where unknown stays unknown", () => {
    const freeze: Policy = {
      version: 1,
      name: "t",
      requirements: [{ id: "freeze", description: "d", kind: "calendar.release-freeze" }],
      gate: { not: { req: "freeze" } },
    };
    expect(judge(freeze, [ev({ kind: "calendar.release-freeze", outcome: "pass" })]).verdict).toBe("NO_GO");
    expect(judge(freeze, [ev({ kind: "calendar.release-freeze", outcome: "fail" })]).verdict).toBe("GO");
    expect(judge(freeze, []).verdict).toBe("UNDETERMINED");
  });
});

describe("waivers", () => {
  const waiver: Waiver = {
    requirementId: "r",
    revision: REV,
    reason: "known flaky suite",
    approvedBy: "release-manager-cy",
    expiresAt: "2026-03-03T00:00:00Z",
  };

  it("turns a failure into GO and says so", () => {
    const report = judge(single(), [ev({ kind: "ci.tests", outcome: "fail" })], [waiver]);
    expect(report.verdict).toBe("GO");
    expect(report.waived).toBe(true);
    expect(report.requirements[0]).toMatchObject({ state: "met", evidenceState: "unmet", reason: "WAIVED" });
  });

  it("is not used when the evidence already meets the requirement", () => {
    const report = judge(single(), [ev({ kind: "ci.tests", outcome: "pass" })], [waiver]);
    expect(report.waived).toBe(false);
    expect(report.requirements[0]?.reason).toBe("PASSED");
  });

  it("stops applying once expired", () => {
    const expired = { ...waiver, expiresAt: "2026-03-02T11:59:00Z" };
    expect(judge(single(), [ev({ kind: "ci.tests", outcome: "fail" })], [expired]).verdict).toBe("NO_GO");
  });

  it("is bound to one revision", () => {
    const other = { ...waiver, revision: "9d07a3e" };
    expect(judge(single(), [ev({ kind: "ci.tests", outcome: "fail" })], [other]).verdict).toBe("NO_GO");
  });
});

describe("reproducibility", () => {
  it("produces the same digest for the same inputs in any order", () => {
    const items = [ev({ kind: "ci.tests", outcome: "pass" }), ev({ kind: "ci.tests", outcome: "pass", source: "x" })];
    expect(judge(single(), items).inputsDigest).toBe(judge(single(), [...items].reverse()).inputsDigest);
  });

  it("changes the digest when any input changes", () => {
    const item = ev({ kind: "ci.tests", outcome: "pass" });
    const a = judge(single(), [item]).inputsDigest;
    const b = judge(single(), [{ ...item, outcome: "fail" }]).inputsDigest;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
