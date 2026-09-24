import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseArenaCases,
  parseArenaGold,
  parseArenaManifest,
  type ArenaCase,
  type ArenaContestantId,
  type ArenaGold,
  type ArenaResult,
  type ArenaSkillManifest,
  type ArenaStatus,
} from "./arena-contracts.js";
import {
  arenaContestantInput,
  createCodexFixtureContestant,
  createJevContestant,
  createJevReplayGateway,
  createRulesContestant,
  type ArenaContestant,
} from "./arena-contestants.js";
import { ARENA_CONTESTANT_ORDER, scoreArena } from "./arena-scorer.js";
import { canonicalFingerprint, canonicalJson } from "./calibration-runner.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES_DIRECTORY = join("fixtures", "arena");
const FIXTURE_NAMES = {
  manifest: "skill-manifest.json",
  cases: "dev-cases.json",
  gold: "dev-gold.json",
  rules: "rules.json",
  jevReplay: "jev-replay.json",
  codexReplay: "codex-replay.json",
  fingerprints: "fingerprints.json",
} as const;

const FINGERPRINT_KEYS = [
  "skillManifest",
  "cases",
  "gold",
  "rules",
  "jevReplay",
  "codexReplay",
] as const;

const STATUSES: readonly ArenaStatus[] = ["ok", "abstain", "error"];

export interface ArenaCliFixtures {
  readonly manifest: ArenaSkillManifest;
  readonly manifestFingerprint: string;
  readonly jevReplay: unknown;
  readonly codexReplay: unknown;
  readonly rules: unknown;
}

export interface ArenaCliOptions {
  readonly repositoryRoot?: string;
  readonly createContestants?: (
    fixtures: ArenaCliFixtures,
  ) => readonly ArenaContestant[];
}

export interface ArenaCliResult {
  readonly exitCode: 0 | 2;
  readonly runDirectory?: string;
  readonly error?: string;
}

class ArenaCliError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ArenaCliError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

interface LoadedFixtures {
  readonly manifest: ArenaSkillManifest;
  readonly cases: readonly ArenaCase[];
  readonly gold: ArenaGold;
  readonly rules: unknown;
  readonly jevReplay: unknown;
  readonly codexReplay: unknown;
  readonly fingerprints: Record<(typeof FINGERPRINT_KEYS)[number], string>;
}

const readJsonFixture = async (root: string, name: string): Promise<unknown> => {
  const serialized = await readFile(join(root, FIXTURES_DIRECTORY, name), "utf8");
  return JSON.parse(serialized);
};

const parsePinnedFingerprints = (
  value: unknown,
): Record<(typeof FINGERPRINT_KEYS)[number], string> => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", ...FINGERPRINT_KEYS]) ||
    value.schemaVersion !== 1
  ) {
    throw new ArenaCliError("invalid-arena-fixtures");
  }
  const pinned = {} as Record<(typeof FINGERPRINT_KEYS)[number], string>;
  for (const key of FINGERPRINT_KEYS) {
    const fingerprint = value[key];
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new ArenaCliError("invalid-arena-fixtures");
    }
    pinned[key] = fingerprint;
  }
  return pinned;
};

const loadFixtures = async (root: string): Promise<LoadedFixtures> => {
  const rawManifest = await readJsonFixture(root, FIXTURE_NAMES.manifest);
  const rawCases = await readJsonFixture(root, FIXTURE_NAMES.cases);
  const rawGold = await readJsonFixture(root, FIXTURE_NAMES.gold);
  const rules = await readJsonFixture(root, FIXTURE_NAMES.rules);
  const jevReplay = await readJsonFixture(root, FIXTURE_NAMES.jevReplay);
  const codexReplay = await readJsonFixture(root, FIXTURE_NAMES.codexReplay);
  const rawFingerprints = await readJsonFixture(root, FIXTURE_NAMES.fingerprints);
  let manifest: ArenaSkillManifest;
  let cases: readonly ArenaCase[];
  let gold: ArenaGold;
  try {
    manifest = parseArenaManifest(rawManifest);
    cases = parseArenaCases(rawCases, manifest);
    gold = parseArenaGold(rawGold, cases, manifest);
  } catch {
    throw new ArenaCliError("invalid-arena-fixtures");
  }
  return {
    manifest,
    cases,
    gold,
    rules,
    jevReplay,
    codexReplay,
    fingerprints: parsePinnedFingerprints(rawFingerprints),
  };
};

const verifyFingerprints = (
  fixtures: LoadedFixtures,
): Record<(typeof FINGERPRINT_KEYS)[number], string> => {
  const computed = {
    skillManifest: canonicalFingerprint(fixtures.manifest),
    cases: canonicalFingerprint(fixtures.cases),
    gold: canonicalFingerprint(fixtures.gold),
    rules: canonicalFingerprint(fixtures.rules),
    jevReplay: canonicalFingerprint(fixtures.jevReplay),
    codexReplay: canonicalFingerprint(fixtures.codexReplay),
  };
  for (const key of FINGERPRINT_KEYS) {
    if (computed[key] !== fixtures.fingerprints[key]) {
      throw new ArenaCliError("arena-fingerprint-mismatch");
    }
  }
  return computed;
};

const defaultContestants = (fixtures: ArenaCliFixtures): readonly ArenaContestant[] => [
  createJevContestant({
    gateway: createJevReplayGateway(fixtures.jevReplay),
    manifestFingerprint: fixtures.manifestFingerprint,
  }),
  createCodexFixtureContestant(fixtures.codexReplay, fixtures.manifest),
  createRulesContestant(fixtures.rules, fixtures.manifest),
];

// Generated artifacts are repository evidence: a file is created once, an
// identical existing file is accepted, and any other content fails closed.
const writeIdenticalOrFail = async (path: string, contents: string): Promise<void> => {
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  if (existing !== null) {
    if (existing !== contents) throw new ArenaCliError("arena-artifact-conflict");
    return;
  }
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    let concurrent: string | null;
    try {
      concurrent = await readFile(path, "utf8");
    } catch {
      concurrent = null;
    }
    if (concurrent !== contents) throw new ArenaCliError("arena-artifact-conflict");
  }
};

const parseRunRecord = (value: unknown, contestantId: ArenaContestantId): ArenaResult => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "caseId",
      "contestantId",
      "status",
      "selectedSkillIds",
      "reason",
      "inputTokens",
      "outputTokens",
      "latencyMs",
      "costUsd",
    ]) ||
    typeof value.caseId !== "string" ||
    value.caseId.length === 0 ||
    value.contestantId !== contestantId ||
    !STATUSES.includes(value.status as ArenaStatus) ||
    !isStringArray(value.selectedSkillIds) ||
    (value.status !== "ok" && value.selectedSkillIds.length !== 0) ||
    !(typeof value.reason === "string" || value.reason === null) ||
    !isNullableNumber(value.inputTokens) ||
    !isNullableNumber(value.outputTokens) ||
    !isNullableNumber(value.latencyMs) ||
    !isNullableNumber(value.costUsd)
  ) {
    throw new ArenaCliError("invalid-arena-run-record");
  }
  return {
    caseId: value.caseId,
    contestantId,
    status: value.status as ArenaStatus,
    selectedSkillIds: [...value.selectedSkillIds],
    reason: value.reason,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    latencyMs: value.latencyMs,
    costUsd: value.costUsd,
  };
};

const readRunFile = async (path: string, contestantId: ArenaContestantId): Promise<ArenaResult[]> => {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch {
    throw new ArenaCliError("invalid-arena-run-record");
  }
  return serialized
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ArenaCliError("invalid-arena-run-record");
      }
      return parseRunRecord(parsed, contestantId);
    });
};

export const runArenaCli = async (
  argv: readonly string[],
  options: ArenaCliOptions = {},
): Promise<ArenaCliResult> => {
  if (argv.length !== 0) {
    return { exitCode: 2, error: "invalid-arena-usage" };
  }
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  try {
    const fixtures = await loadFixtures(repositoryRoot);
    const fingerprints = verifyFingerprints(fixtures);
    const combinedFingerprint = canonicalFingerprint(fingerprints);
    const runId = `dev-${combinedFingerprint.slice(0, 12)}`;
    const runDirectory = join("artifacts", "arena", runId);
    const runRoot = join(repositoryRoot, runDirectory);

    const contestants = (options.createContestants ?? defaultContestants)({
      manifest: fixtures.manifest,
      manifestFingerprint: fingerprints.skillManifest,
      jevReplay: fixtures.jevReplay,
      codexReplay: fixtures.codexReplay,
      rules: fixtures.rules,
    });
    if (
      contestants.length !== ARENA_CONTESTANT_ORDER.length ||
      contestants.some(
        (contestant, index) => contestant.id !== ARENA_CONTESTANT_ORDER[index],
      )
    ) {
      throw new ArenaCliError("invalid-arena-contestants");
    }

    const orderedCases = [...fixtures.cases].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    const runs = {} as Record<ArenaContestantId, ArenaResult[]>;
    for (const contestant of contestants) {
      const results: ArenaResult[] = [];
      for (const arenaCase of orderedCases) {
        try {
          results.push(await contestant.run(arenaContestantInput(arenaCase, fixtures.manifest)));
        } catch {
          throw new ArenaCliError("arena-run-failed");
        }
      }
      runs[contestant.id] = results;
    }

    await mkdir(join(runRoot, "runs"), { recursive: true });
    const manifestArtifact = canonicalJson({
      schemaVersion: 1,
      scope: "development",
      combinedFingerprint,
      fingerprints,
    });
    const casesArtifact = canonicalJson({ schemaVersion: 1, cases: orderedCases });
    const goldArtifact = canonicalJson({
      schemaVersion: 1,
      records: fixtures.gold.records,
      provenance: fixtures.gold.provenance,
    });
    await writeIdenticalOrFail(join(runRoot, "manifest.json"), `${manifestArtifact}\n`);
    await writeIdenticalOrFail(join(runRoot, "cases.json"), `${casesArtifact}\n`);
    await writeIdenticalOrFail(join(runRoot, "gold.json"), `${goldArtifact}\n`);
    for (const contestantId of ARENA_CONTESTANT_ORDER) {
      const lines = (runs[contestantId] ?? []).map((result) => canonicalJson(result));
      await writeIdenticalOrFail(
        join(runRoot, "runs", `${contestantId}.jsonl`),
        `${lines.join("\n")}\n`,
      );
    }

    // The scoreboard consumes the recorded run files, never the live results.
    const recorded = {} as Record<ArenaContestantId, ArenaResult[]>;
    for (const contestantId of ARENA_CONTESTANT_ORDER) {
      recorded[contestantId] = await readRunFile(
        join(runRoot, "runs", `${contestantId}.jsonl`),
        contestantId,
      );
    }
    const scoreboard = scoreArena({
      manifest: fixtures.manifest,
      cases: fixtures.cases,
      gold: fixtures.gold,
      runs: recorded,
    });
    await writeIdenticalOrFail(
      join(runRoot, "scoreboard.json"),
      `${canonicalJson(scoreboard)}\n`,
    );
    return { exitCode: 0, runDirectory: runDirectory.split("\\").join("/") };
  } catch (error) {
    if (error instanceof ArenaCliError) {
      return { exitCode: 2, error: error.reason };
    }
    if (error instanceof SyntaxError) {
      return { exitCode: 2, error: "invalid-arena-fixtures" };
    }
    if (hasErrorCode(error, "ENOENT")) {
      return { exitCode: 2, error: "invalid-arena-fixtures" };
    }
    return { exitCode: 2, error: "arena-run-failed" };
  }
};

const main = async (): Promise<void> => {
  const result = await runArenaCli(process.argv.slice(2));
  if (result.runDirectory !== undefined) {
    process.stdout.write(`${JSON.stringify({ runDirectory: result.runDirectory })}\n`);
  }
  if (result.error !== undefined) {
    process.stderr.write(`${result.error}\n`);
  }
  process.exitCode = result.exitCode;
};

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  pathToFileURL(resolve(entrypoint)).href === import.meta.url
) {
  void main();
}
