#!/usr/bin/env node
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluate } from "./evaluate.js";
import { renderText } from "./render.js";
import type { Evidence, Verdict } from "./types.js";
import { assertUniqueIds, InputError, parseEvidenceList, parsePolicy, parseWaivers } from "./validate.js";

/** Exit codes are the CI contract: a pipeline can tell "no" from "cannot tell". */
export const EXIT: Record<Verdict | "INPUT_ERROR", number> = {
  GO: 0,
  NO_GO: 1,
  UNDETERMINED: 2,
  INPUT_ERROR: 3,
};

const USAGE = `usage: evidence-gate --policy <file> --evidence <file|dir>... --revision <id>
                     [--waivers <file>] [--now <iso-instant>] [--format text|json]
                     [--clock-skew-seconds <n>]

exit codes: 0 GO, 1 NO_GO, 2 UNDETERMINED, 3 invalid input`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

function readJson(path: string): unknown {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    throw new InputError(`cannot read ${path}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new InputError(`${path}: not valid JSON`);
  }
}

function loadEvidence(path: string): Evidence[] {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new InputError(`cannot read ${path}`);
  }
  if (stats.isDirectory()) {
    return readdirSync(path)
      .filter((name) => name.endsWith(".json") || name.endsWith(".jsonl"))
      .sort()
      .flatMap((name) => loadEvidence(join(path, name)));
  }
  if (path.endsWith(".jsonl")) {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line, i) => {
        try {
          return parseEvidenceList(JSON.parse(line), `${path}:${i + 1}`);
        } catch (error) {
          if (error instanceof InputError) throw error;
          throw new InputError(`${path}:${i + 1}: not valid JSON`);
        }
      });
  }
  return parseEvidenceList(readJson(path), path);
}

export function run(argv: readonly string[], io: Io): number {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        policy: { type: "string" },
        evidence: { type: "string", multiple: true },
        waivers: { type: "string" },
        revision: { type: "string" },
        now: { type: "string" },
        format: { type: "string", default: "text" },
        "clock-skew-seconds": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (!values.policy || !values.revision || !values.evidence?.length) {
      throw new InputError("--policy, --revision and at least one --evidence are required");
    }
    if (values.format !== "text" && values.format !== "json") {
      throw new InputError('--format must be "text" or "json"');
    }
    const now = values.now === undefined ? new Date() : new Date(values.now);
    if (Number.isNaN(now.getTime())) throw new InputError("--now is not a valid instant");
    const skew = values["clock-skew-seconds"] === undefined ? undefined : Number(values["clock-skew-seconds"]);
    if (skew !== undefined && (!Number.isFinite(skew) || skew < 0)) {
      throw new InputError("--clock-skew-seconds must be a non-negative number");
    }

    const evidence = values.evidence.flatMap(loadEvidence);
    assertUniqueIds(evidence);
    const report = evaluate({
      policy: parsePolicy(readJson(values.policy)),
      evidence,
      revision: values.revision,
      now,
      ...(values.waivers === undefined ? {} : { waivers: parseWaivers(readJson(values.waivers)) }),
      ...(skew === undefined ? {} : { clockSkewSeconds: skew }),
    });
    io.out(values.format === "json" ? JSON.stringify(report, null, 2) : renderText(report));
    return EXIT[report.verdict];
  } catch (error) {
    // Malformed input is its own outcome. It must never be mistaken for a verdict.
    const message = error instanceof Error ? error.message : String(error);
    io.err(`evidence-gate: ${message}\n\n${USAGE}`);
    return EXIT.INPUT_ERROR;
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
}
