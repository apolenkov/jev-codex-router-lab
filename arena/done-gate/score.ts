/**
 * Deterministic offline scorer for the done-gate calibration corpus.
 *
 * Joins frozen per-claim gold labels (corpus/*.jsonl, pinned by
 * manifest.sha256) with recorded jev_verify per-claim results and reports
 * precision / recall / FN-rate for the auto-accept threshold grid.
 *
 * This tool never performs provider calls: it only reads local files.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERDICTS = ["verified", "contradicted", "unsupported"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface EvidenceItem {
  readonly id: string;
  readonly text: string;
}

export interface CorpusCase {
  readonly id: string;
  readonly source: string;
  readonly domain: string;
  readonly tags: readonly string[];
  readonly claims: readonly string[];
  readonly evidence: readonly EvidenceItem[];
  readonly gold: readonly Verdict[];
}

export interface ClaimResult {
  readonly claimIndex: number;
  readonly verdict: Verdict;
  readonly probabilities: Readonly<Record<Verdict, number>>;
  readonly confidence: number | null;
  readonly action: string | null;
}

export interface CaseResult {
  readonly caseId: string;
  readonly results: readonly ClaimResult[];
}

export interface ScoredClaim {
  readonly caseId: string;
  readonly domain: string;
  readonly source: string;
  readonly claimIndex: number;
  readonly gold: Verdict;
  readonly predicted: Verdict;
  readonly probabilities: Readonly<Record<Verdict, number>>;
}

export interface ThresholdRow {
  readonly threshold: number;
  readonly scoredClaims: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly fnRate: number | null;
  readonly fpRate: number | null;
  readonly contradictedTotal: number;
  readonly contradictedCaught: number;
  readonly contradictedRate: number | null;
}

export interface ScoreSummary {
  readonly corpus: {
    readonly cases: number;
    readonly claims: number;
    readonly gold: Readonly<Record<Verdict, number>>;
  };
  readonly results: {
    readonly file: string;
    readonly casesScored: number;
    readonly claimsScored: number;
    readonly uncoveredCaseIds: readonly string[];
  };
  readonly rows: readonly ThresholdRow[];
}

export const AUTO_ACCEPT_GRID: readonly number[] = [
  0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
];

export class ScoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreInputError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isVerdict = (value: unknown): value is Verdict =>
  typeof value === "string" && (VERDICTS as readonly string[]).includes(value);

const asNonEmptyString = (value: unknown, context: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ScoreInputError(`${context}: expected non-empty string`);
  }
  return value;
};

const asProbability = (value: unknown, context: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ScoreInputError(`${context}: expected probability in [0, 1]`);
  }
  return value;
};

const asVerdict = (value: unknown, context: string): Verdict => {
  if (!isVerdict(value)) {
    throw new ScoreInputError(`${context}: expected one of ${VERDICTS.join("|")}`);
  }
  return value;
};

const readJsonLines = (path: string, kind: string): readonly unknown[] => {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch {
    throw new ScoreInputError(`${kind}: cannot read ${path}`);
  }
  return serialized.split("\n").flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      throw new ScoreInputError(`${kind}: ${path}:${index + 1}: invalid JSON line`);
    }
  });
};

const parseEvidenceItem = (value: unknown, context: string): EvidenceItem => {
  if (!isRecord(value)) {
    throw new ScoreInputError(`${context}: evidence item must be an object`);
  }
  return {
    id: asNonEmptyString(value.id, `${context}.id`),
    text: asNonEmptyString(value.text, `${context}.text`),
  };
};

export const parseCorpusCase = (value: unknown, context: string): CorpusCase => {
  if (!isRecord(value)) {
    throw new ScoreInputError(`${context}: corpus case must be an object`);
  }
  const id = asNonEmptyString(value.id, `${context}.id`);
  const source = asNonEmptyString(value.source, `${id}.source`);
  const domain = asNonEmptyString(value.domain, `${id}.domain`);
  if (!Array.isArray(value.claims) || value.claims.length === 0) {
    throw new ScoreInputError(`${id}: claims must be a non-empty array`);
  }
  const claims = value.claims.map((claim, index) =>
    asNonEmptyString(claim, `${id}.claims[${index}]`),
  );
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new ScoreInputError(`${id}: evidence must be a non-empty array`);
  }
  const evidence = value.evidence.map((item, index) =>
    parseEvidenceItem(item, `${id}.evidence[${index}]`),
  );
  if (!Array.isArray(value.gold) || value.gold.length !== claims.length) {
    throw new ScoreInputError(`${id}: gold must align with claims (${claims.length})`);
  }
  const gold = value.gold.map((verdict, index) =>
    asVerdict(verdict, `${id}.gold[${index}]`),
  );
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag, index) => asNonEmptyString(tag, `${id}.tags[${index}]`))
    : [];
  return { id, source, domain, tags, claims, evidence, gold };
};

const parseProbabilities = (
  value: unknown,
  context: string,
): Readonly<Record<Verdict, number>> => {
  if (!isRecord(value)) {
    throw new ScoreInputError(`${context}: probabilities must be an object`);
  }
  const probabilities = {} as Record<Verdict, number>;
  for (const verdict of VERDICTS) {
    probabilities[verdict] = asProbability(value[verdict], `${context}.${verdict}`);
  }
  return probabilities;
};

const parseClaimResult = (value: unknown, context: string): ClaimResult => {
  if (!isRecord(value)) {
    throw new ScoreInputError(`${context}: claim result must be an object`);
  }
  const claimIndex = value.claim_index;
  if (typeof claimIndex !== "number" || !Number.isInteger(claimIndex) || claimIndex < 0) {
    throw new ScoreInputError(`${context}: claim_index must be a non-negative integer`);
  }
  let confidence: number | null = null;
  if (value.confidence !== undefined && value.confidence !== null) {
    confidence = asProbability(value.confidence, `${context}.confidence`);
  }
  let action: string | null = null;
  if (value.action !== undefined && value.action !== null) {
    action = asNonEmptyString(value.action, `${context}.action`);
  }
  return {
    claimIndex,
    verdict: asVerdict(value.verdict, `${context}.verdict`),
    probabilities: parseProbabilities(value.probabilities, `${context}.probabilities`),
    confidence,
    action,
  };
};

export const parseCaseResult = (value: unknown, context: string): CaseResult => {
  if (!isRecord(value)) {
    throw new ScoreInputError(`${context}: result row must be an object`);
  }
  const caseId = asNonEmptyString(value.case_id, `${context}.case_id`);
  if (!Array.isArray(value.results) || value.results.length === 0) {
    throw new ScoreInputError(`${caseId}: results must be a non-empty array`);
  }
  const results = value.results.map((item, index) =>
    parseClaimResult(item, `${caseId}.results[${index}]`),
  );
  const seen = new Set<number>();
  for (const result of results) {
    if (seen.has(result.claimIndex)) {
      throw new ScoreInputError(`${caseId}: duplicate result for claim_index ${result.claimIndex}`);
    }
    seen.add(result.claimIndex);
  }
  return { caseId, results };
};

export const corpusFilePaths = (corpusPath: string): readonly string[] => {
  let stat;
  try {
    stat = statSync(corpusPath);
  } catch {
    throw new ScoreInputError(`corpus: cannot stat ${corpusPath}`);
  }
  if (stat.isDirectory()) {
    const files = readdirSync(corpusPath)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    if (files.length === 0) {
      throw new ScoreInputError(`corpus: no .jsonl files in ${corpusPath}`);
    }
    return files.map((name) => join(corpusPath, name));
  }
  return [corpusPath];
};

export const loadCorpus = (corpusPath: string): readonly CorpusCase[] => {
  const cases: CorpusCase[] = [];
  const ids = new Set<string>();
  for (const file of corpusFilePaths(corpusPath)) {
    for (const [index, raw] of readJsonLines(file, "corpus").entries()) {
      const parsed = parseCorpusCase(raw, `${basename(file)}:${index + 1}`);
      if (ids.has(parsed.id)) {
        throw new ScoreInputError(`corpus: duplicate case id ${parsed.id}`);
      }
      ids.add(parsed.id);
      cases.push(parsed);
    }
  }
  return cases;
};

export const loadResults = (resultsPath: string): readonly CaseResult[] => {
  const rows: CaseResult[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of readJsonLines(resultsPath, "results").entries()) {
    const parsed = parseCaseResult(raw, `${basename(resultsPath)}:${index + 1}`);
    if (ids.has(parsed.caseId)) {
      throw new ScoreInputError(`results: duplicate case_id ${parsed.caseId}`);
    }
    ids.add(parsed.caseId);
    rows.push(parsed);
  }
  return rows;
};

const sha256 = (content: Buffer): string =>
  createHash("sha256").update(content).digest("hex");

export interface ManifestEntry {
  readonly hash: string;
  readonly relativePath: string;
}

export const parseManifest = (serialized: string): readonly ManifestEntry[] =>
  serialized.split("\n").flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const match = /^([0-9a-f]{64}) {1,2}(\S.*)$/.exec(trimmed);
    if (match === null) {
      throw new ScoreInputError(`manifest: line ${index + 1}: malformed entry`);
    }
    return [{ hash: match[1]!, relativePath: match[2]! }];
  });

export const verifyManifest = (
  manifestPath: string,
  corpusDir: string,
): readonly string[] => {
  const problems: string[] = [];
  let serialized: string;
  try {
    serialized = readFileSync(manifestPath, "utf8");
  } catch {
    return [`manifest: cannot read ${manifestPath}`];
  }
  const entries = parseManifest(serialized);
  const manifestDir = dirname(manifestPath);
  const listed = new Set<string>();
  for (const entry of entries) {
    if (!entry.relativePath.startsWith("corpus/") || entry.relativePath.includes("..")) {
      problems.push(`manifest: unexpected path ${entry.relativePath}`);
      continue;
    }
    listed.add(entry.relativePath);
    let content: Buffer;
    try {
      content = readFileSync(join(manifestDir, entry.relativePath));
    } catch {
      problems.push(`manifest: missing file ${entry.relativePath}`);
      continue;
    }
    if (sha256(content) !== entry.hash) {
      problems.push(`manifest: hash mismatch for ${entry.relativePath}`);
    }
  }
  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(corpusDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => `corpus/${name}`);
  } catch {
    problems.push(`manifest: cannot list ${corpusDir}`);
  }
  for (const path of onDisk) {
    if (!listed.has(path)) {
      problems.push(`manifest: unlisted corpus file ${path}`);
    }
  }
  return problems;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export const joinResults = (
  cases: readonly CorpusCase[],
  results: readonly CaseResult[],
): { readonly scored: readonly ScoredClaim[]; readonly uncoveredCaseIds: readonly string[] } => {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const scored: ScoredClaim[] = [];
  const covered = new Set<string>();
  for (const row of results) {
    const corpusCase = byId.get(row.caseId);
    if (corpusCase === undefined) {
      throw new ScoreInputError(`results: unknown case_id ${row.caseId}`);
    }
    const indices = row.results.map((result) => result.claimIndex);
    const expected = new Set(corpusCase.claims.map((_, index) => index));
    const missing = [...expected].filter((index) => !indices.includes(index));
    const outOfRange = indices.filter((index) => !expected.has(index));
    if (missing.length > 0 || outOfRange.length > 0) {
      throw new ScoreInputError(
        `results: ${row.caseId} claim coverage mismatch ` +
          `(missing: ${missing.join(",") || "none"}; out of range: ${outOfRange.join(",") || "none"})`,
      );
    }
    covered.add(row.caseId);
    for (const result of row.results) {
      const gold = corpusCase.gold[result.claimIndex];
      if (gold === undefined) {
        throw new ScoreInputError(`results: ${row.caseId} claim_index ${result.claimIndex} has no gold`);
      }
      scored.push({
        caseId: corpusCase.id,
        domain: corpusCase.domain,
        source: corpusCase.source,
        claimIndex: result.claimIndex,
        gold,
        predicted: result.verdict,
        probabilities: result.probabilities,
      });
    }
  }
  const uncoveredCaseIds = cases
    .map((entry) => entry.id)
    .filter((id) => !covered.has(id));
  return { scored, uncoveredCaseIds };
};

export const scoreAt = (
  scored: readonly ScoredClaim[],
  threshold: number,
): ThresholdRow => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let contradictedTotal = 0;
  let contradictedCaught = 0;
  for (const claim of scored) {
    const autoAccepted =
      claim.predicted === "verified" && claim.probabilities.verified >= threshold;
    if (claim.gold === "verified") {
      if (autoAccepted) {
        tp += 1;
      } else {
        fn += 1;
      }
    } else if (autoAccepted) {
      fp += 1;
    } else {
      tn += 1;
    }
    if (claim.gold === "contradicted") {
      contradictedTotal += 1;
      if (
        claim.predicted === "contradicted" &&
        claim.probabilities.contradicted >= threshold
      ) {
        contradictedCaught += 1;
      }
    }
  }
  return {
    threshold,
    scoredClaims: scored.length,
    tp,
    fp,
    fn,
    tn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    fnRate: ratio(fn, tp + fn),
    fpRate: ratio(fp, fp + tn),
    contradictedTotal,
    contradictedCaught,
    contradictedRate: ratio(contradictedCaught, contradictedTotal),
  };
};

export const scoreResults = (
  cases: readonly CorpusCase[],
  results: readonly CaseResult[],
  grid: readonly number[] = AUTO_ACCEPT_GRID,
): ScoreSummary => {
  const { scored, uncoveredCaseIds } = joinResults(cases, results);
  const goldCounts: Record<Verdict, number> = {
    verified: 0,
    contradicted: 0,
    unsupported: 0,
  };
  let claims = 0;
  for (const corpusCase of cases) {
    claims += corpusCase.gold.length;
    for (const verdict of corpusCase.gold) {
      goldCounts[verdict] += 1;
    }
  }
  const coveredCaseIds = new Set(results.map((row) => row.caseId));
  return {
    corpus: { cases: cases.length, claims, gold: goldCounts },
    results: {
      file: "",
      casesScored: coveredCaseIds.size,
      claimsScored: scored.length,
      uncoveredCaseIds,
    },
    rows: grid.map((threshold) => scoreAt(scored, threshold)),
  };
};

const formatRatio = (value: number | null): string =>
  value === null ? "-" : value.toFixed(3);

const formatTable = (summary: ScoreSummary): string => {
  const header =
    "threshold   TP   FP   FN   TN  precision  recall  fn-rate  fp-rate  caught(C)";
  const lines = summary.rows.map((row) =>
    [
      row.threshold.toFixed(2).padStart(8),
      String(row.tp).padStart(5),
      String(row.fp).padStart(5),
      String(row.fn).padStart(5),
      String(row.tn).padStart(5),
      formatRatio(row.precision).padStart(11),
      formatRatio(row.recall).padStart(8),
      formatRatio(row.fnRate).padStart(8),
      formatRatio(row.fpRate).padStart(8),
      `${String(row.contradictedCaught)}/${String(row.contradictedTotal)}`.padStart(9),
    ].join(""),
  );
  const gold = summary.corpus.gold;
  return [
    "done-gate calibration scoring (offline, deterministic; no provider calls)",
    `corpus: ${summary.corpus.cases} cases / ${summary.corpus.claims} claims ` +
      `(gold: ${gold.verified} verified / ${gold.contradicted} contradicted / ${gold.unsupported} unsupported)`,
    `results: ${summary.results.file} — ${summary.results.casesScored} cases scored, ` +
      `${summary.results.claimsScored} claims; corpus coverage ` +
      `${summary.corpus.cases - summary.results.uncoveredCaseIds.length}/${summary.corpus.cases}`,
    header,
    ...lines,
  ].join("\n");
};

interface CliOptions {
  readonly corpus: string;
  readonly results: string;
  readonly manifest: string | null;
  readonly requireAll: boolean;
  readonly json: boolean;
  readonly domain: string | null;
}

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const USAGE = [
  "usage: score.js [--corpus <dir|file>] [--results <file>] [--manifest <file>]",
  "                [--domain <name>] [--require-all] [--json] [--no-manifest-check]",
  "defaults resolve against the repository root:",
  "  --corpus   arena/done-gate/corpus",
  "  --results  arena/done-gate/fixtures/results.sample.jsonl",
  "  --manifest arena/done-gate/manifest.sha256",
].join("\n");

const takeValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ScoreInputError(`cli: ${flag} requires a value`);
  }
  return value;
};

export const parseArgs = (
  argv: readonly string[],
  root: string = DEFAULT_ROOT,
): CliOptions => {
  let corpus: string | null = null;
  let results: string | null = null;
  let manifest: string | null = null;
  let manifestDisabled = false;
  let requireAll = false;
  let json = false;
  let domain: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--corpus":
        corpus = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--results":
        results = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--manifest":
        manifest = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--domain":
        domain = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--require-all":
        requireAll = true;
        break;
      case "--json":
        json = true;
        break;
      case "--no-manifest-check":
        manifestDisabled = true;
        break;
      case "--help":
      case "-h":
        throw new ScoreInputError(USAGE);
      default:
        throw new ScoreInputError(`cli: unknown argument ${String(arg)}\n${USAGE}`);
    }
  }
  // Defaults anchor to the repository root; explicit relative paths follow cwd.
  const absolutize = (path: string | null, fallback: string): string => {
    if (path === null) {
      return fallback;
    }
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
  };
  return {
    corpus: absolutize(corpus, join(root, "arena/done-gate/corpus")),
    results: absolutize(results, join(root, "arena/done-gate/fixtures/results.sample.jsonl")),
    manifest: manifestDisabled
      ? null
      : absolutize(manifest, join(root, "arena/done-gate/manifest.sha256")),
    requireAll,
    json,
    domain,
  };
};

export interface ScoreCliResult {
  readonly exitCode: 0 | 2;
  readonly output?: string;
  readonly error?: string;
}

export const runScoreCli = (
  argv: readonly string[],
  root: string = DEFAULT_ROOT,
): ScoreCliResult => {
  let options: CliOptions;
  try {
    options = parseArgs(argv, root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, error: message };
  }

  try {
    if (options.manifest !== null) {
      const corpusDir = statSync(options.corpus).isDirectory()
        ? options.corpus
        : dirname(options.corpus);
      const problems = verifyManifest(options.manifest, corpusDir);
      if (problems.length > 0) {
        return { exitCode: 2, error: `manifest check failed:\n${problems.join("\n")}` };
      }
    }
    const corpus = loadCorpus(options.corpus);
    const selected = options.domain === null
      ? corpus
      : corpus.filter((entry) => entry.domain === options.domain);
    if (options.domain !== null && selected.length === 0) {
      return { exitCode: 2, error: `corpus: no cases for domain ${options.domain}` };
    }
    const results = loadResults(options.results);
    // Domain slicing also slices the results set; outside rows are not errors.
    const selectedIds = new Set(selected.map((entry) => entry.id));
    const effectiveResults = options.domain === null
      ? results
      : results.filter((row) => selectedIds.has(row.caseId));
    const summary = scoreResults(selected, effectiveResults);
    const withFile: ScoreSummary = {
      ...summary,
      results: { ...summary.results, file: options.results },
    };
    if (options.requireAll && withFile.results.uncoveredCaseIds.length > 0) {
      return {
        exitCode: 2,
        error:
          `results do not cover ${withFile.results.uncoveredCaseIds.length} corpus cases ` +
          `(first: ${withFile.results.uncoveredCaseIds[0]})`,
      };
    }
    const output = options.json
      ? JSON.stringify(withFile, null, 2)
      : formatTable(withFile);
    return { exitCode: 0, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 2, error: message };
  }
};

const main = (): void => {
  const result = runScoreCli(process.argv.slice(2));
  if (result.output !== undefined) {
    process.stdout.write(`${result.output}\n`);
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
  main();
}
