import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, run } from "../src/cli.js";

function invoke(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const base = ["--policy", "examples/policy.json", "--revision", "4be1c02", "--now", "2026-03-02T12:00:00Z"];

describe("cli, against the bundled examples", () => {
  it("exits 0 for GO", () => {
    const result = invoke([...base, "--evidence", "examples/evidence/go.json"]);
    expect(result.code).toBe(EXIT.GO);
    expect(result.out).toContain("VERDICT   GO");
  });

  it("exits 1 for NO_GO", () => {
    const result = invoke([...base, "--evidence", "examples/evidence/no-go.json"]);
    expect(result.code).toBe(EXIT.NO_GO);
  });

  it("exits 2 for UNDETERMINED and says what would settle it", () => {
    const result = invoke([...base, "--evidence", "examples/evidence/undetermined.json"]);
    expect(result.code).toBe(EXIT.UNDETERMINED);
    expect(result.out).toContain("To settle it:");
    expect(result.out).toContain("dependency-scan");
  });

  it("emits a JSON report and does not claim a waiver it did not need", () => {
    const result = invoke([
      ...base,
      "--evidence", "examples/evidence/go.json",
      "--waivers", "examples/waivers.json",
      "--format", "json",
    ]);
    const report = JSON.parse(result.out) as { verdict: string; waived: boolean };
    expect(report.verdict).toBe("GO");
    expect(report.waived).toBe(false);
  });

  it("reads a directory of .json and .jsonl evidence files", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-gate-"));
    const line = (id: string, kind: string, actor?: string) =>
      JSON.stringify({ id, kind, revision: "4be1c02", outcome: "pass", observedAt: "2026-03-02T11:30:00Z", source: "s", ...(actor ? { actor } : {}) });
    writeFileSync(join(dir, "a.jsonl"), [line("1", "ci.tests"), line("2", "ci.lint"), ""].join("\n"));
    writeFileSync(
      join(dir, "b.json"),
      `[${[line("3", "review.approval", "ana"), line("4", "review.approval", "bo"), line("5", "scan.dependencies"), line("6", "deploy.canary-health")].join(",")}]`,
    );
    expect(invoke([...base, "--evidence", dir]).code).toBe(EXIT.GO);
  });
});

describe("cli input errors are never mistaken for a verdict", () => {
  it("exits 3 when required flags are missing", () => {
    const result = invoke(["--policy", "examples/policy.json"]);
    expect(result.code).toBe(EXIT.INPUT_ERROR);
    expect(result.err).toContain("usage:");
  });

  it("exits 3 for an unreadable evidence path", () => {
    expect(invoke([...base, "--evidence", "examples/evidence/does-not-exist.json"]).code).toBe(EXIT.INPUT_ERROR);
  });

  it("exits 3 for malformed evidence rather than ignoring the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-gate-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify([{ id: "x", kind: "ci.tests" }]));
    const result = invoke([...base, "--evidence", file]);
    expect(result.code).toBe(EXIT.INPUT_ERROR);
    expect(result.err).toContain("outcome");
  });

  it("exits 3, not 0, when a policy key is misspelled", () => {
    // With one approval this policy is UNDETERMINED. Misspelling the two-person rule must not
    // quietly remove it and turn the verdict into GO.
    const policy = JSON.parse(readFileSync("examples/policy.json", "utf8")) as {
      requirements: Record<string, unknown>[];
    };
    const review = policy.requirements.find((r) => r["id"] === "review-approved");
    if (review === undefined) throw new Error("fixture changed");
    delete review["minDistinctActors"];
    review["minDistinctActor"] = 2;
    const file = join(mkdtempSync(join(tmpdir(), "evidence-gate-")), "policy.json");
    writeFileSync(file, JSON.stringify(policy));
    const result = invoke(["--policy", file, ...base.slice(2), "--evidence", "examples/evidence/go.json"]);
    expect(result.code).toBe(EXIT.INPUT_ERROR);
    expect(result.err).toContain('unknown key "minDistinctActor"');
  });

  it("exits 3 for a --now with no UTC offset, so the verdict cannot depend on the local timezone", () => {
    const result = invoke([...base.slice(0, 4), "--now", "2026-03-02T12:00:00", "--evidence", "examples/evidence/go.json"]);
    expect(result.code).toBe(EXIT.INPUT_ERROR);
    expect(result.err).toContain("UTC offset");
  });

  it("reports the real line number of a bad JSONL record, counting blank lines", () => {
    const file = join(mkdtempSync(join(tmpdir(), "evidence-gate-")), "e.jsonl");
    const good = JSON.stringify({ id: "1", kind: "ci.tests", revision: "4be1c02", outcome: "pass", observedAt: "2026-03-02T11:30:00Z", source: "s" });
    writeFileSync(file, [good, "", "{not json", ""].join("\n"));
    const result = invoke([...base, "--evidence", file]);
    expect(result.code).toBe(EXIT.INPUT_ERROR);
    expect(result.err).toContain(`${file}:3: not valid JSON`);
  });

  it("exits 3 for an unknown flag", () => {
    expect(invoke([...base, "--evidence", "examples/evidence/go.json", "--force"]).code).toBe(EXIT.INPUT_ERROR);
  });

  it("exits 3 for an invalid --now", () => {
    expect(invoke([...base.slice(0, 4), "--now", "soon", "--evidence", "examples/evidence/go.json"]).code).toBe(EXIT.INPUT_ERROR);
  });
});
