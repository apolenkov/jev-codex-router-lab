/**
 * Live `jev_verify` runner for the done-gate calibration corpus.
 *
 * Replicates the request construction of `@jkudish/jev-mcp` 0.5.0 `jev_verify`
 * verbatim (same `state`, same `questions`, same response mapping) over the
 * repository's pinned `@typesafe-ai/sdk` transport, then writes one results
 * line per corpus case in the format `score.js` consumes.
 *
 * `auto_accept` is never sent: raw `verdict`/`probabilities`/`confidence` are
 * recorded so the offline threshold grid can be applied without new calls.
 * The `action` field still mirrors what the tool would emit under its own
 * default (`auto_accept` 0.8) and is ignored by the scorer.
 *
 * Budget: at most `--max-calls` provider calls and about `--max-input-tokens`
 * cumulative input tokens; the run stops when either is exceeded and reports
 * partial coverage. No verdict-shaping retries: a transport failure is
 * appended to the errors file and the run moves on. Re-running the same
 * results path skips cases that already have a row (resume, no double spend).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TypeSafeClient,
  choice,
  type ChoiceQuestion,
  type EntryType,
  type Questions,
} from "@typesafe-ai/sdk";
import { loadCorpus, type CorpusCase, type Verdict } from "./score.js";

export const JEV_MCP_VERSION = "0.5.0";
export const DEFAULT_MODEL = "jev-1.13.0";
export const DEFAULT_MAX_CALLS = 150;
export const DEFAULT_MAX_INPUT_TOKENS = 200_000;
/** `jev_verify` tool default; recorded in `action`, never sent. */
export const TOOL_DEFAULT_AUTO_ACCEPT = 0.8;
/** Same price sheet as src/calibration-runner.ts calibration accounting. */
export const INPUT_USD_PER_MILLION = 0.042;
export const OUTPUT_USD_PER_MILLION = 0;

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export class RunLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLiveError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// --- begin verbatim copies from @jkudish/jev-mcp 0.5.0 (dist/lib.js) ---
/** Sanitize a caller-supplied id into a safe Choice option key. */
const sanitizeId = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "";
};

interface IdentifiedItem {
  readonly id: string;
}

/** Ensure ids exist, are safe, and are unique; returns the id actually used per candidate. */
const ensureUniqueIds = <T extends { id?: string }>(
  items: readonly T[],
  fallbackPrefix: string,
): (T & IdentifiedItem)[] => {
  const used = new Set<string>();
  const out: (T & IdentifiedItem)[] = [];
  for (const [i, item] of items.entries()) {
    const raw = item.id ?? "";
    const base = sanitizeId(raw) || `${fallbackPrefix}${i}`;
    let id = base;
    let n = 1;
    while (used.has(id)) {
      id = `${base}_${n++}`;
    }
    used.add(id);
    out.push({ ...item, id });
  }
  return out;
};

/** Map a jev_verify relation answer to a verdict label (citation-check cookbook). */
const RELATION_TO_VERDICT: Readonly<Record<string, Verdict>> = {
  supports: "verified",
  contradicts: "contradicted",
  says_nothing: "unsupported",
};

/** Does this verdict stand on its own, or should a human confirm it? */
const verifyAction = (confidence: number, autoAccept: number): string =>
  confidence >= autoAccept ? "auto" : "review";
// --- end verbatim copies ---

const RELATION_LABELS = ["supports", "contradicts", "says_nothing"] as const;

interface ClaimWireResult {
  readonly claim_index: number;
  readonly verdict: Verdict;
  readonly probabilities: Readonly<Record<Verdict, number>>;
  readonly confidence: number;
  readonly action: string;
  readonly supporting_evidence: string | null;
}

interface CaseWireResult {
  readonly case_id: string;
  readonly model: string;
  readonly results: readonly ClaimWireResult[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latency_ms: number;
}

interface CaseError {
  readonly case_id: string;
  readonly error: string;
  readonly latency_ms: number;
}

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Build the exact `{state, questions}` pair jev_verify 0.5.0 sends for one
 * corpus case (`auto_accept` never leaves the tool; it only post-processes
 * confidence into `action`).
 */
export const buildVerifyRequest = (
  corpusCase: CorpusCase,
): { state: EntryType; questions: Questions } => {
  const evidence = ensureUniqueIds(corpusCase.evidence, "evidence");
  const claimItems = ensureUniqueIds(
    corpusCase.claims.map((text): { id?: string; text: string } => ({ text })),
    "claim",
  );
  const questions: Record<string, ChoiceQuestion> = {};
  for (const claim of claimItems) {
    questions[`relation_${claim.id}`] = choice(
      `How does the evidence relate to claim \`${claim.id}\` (${claim.text})?`,
      {
        supports: "The evidence states the claim or directly implies that it is true",
        contradicts:
          "The evidence states the opposite of the claim or implies that it is false",
        says_nothing:
          "The evidence does not address what the claim asserts, either way",
      },
    );
    if (evidence.length > 1) {
      const criteria: Record<string, string | null> = {};
      for (const item of evidence) {
        criteria[item.id] = null;
      }
      criteria["none"] =
        "No single evidence item contains the content the claim depends on";
      questions[`source_${claim.id}`] = choice(
        `Which evidence item does claim \`${claim.id}\` (${claim.text}) rest on?`,
        criteria,
      );
    }
  }
  const state: EntryType = {
    purpose: "Verify each claim in claims against the evidence in evidence.",
    claims: claimItems.map((item) => ({ text: item.text, id: item.id })),
    evidence: evidence.map((item) => ({ id: item.id, text: item.text })),
  };
  return { state, questions };
};

const parseChoiceAnswer = (
  value: unknown,
  context: string,
): { choice: string; confidence: number; probabilities: Record<string, number> } => {
  if (
    !isRecord(value) ||
    value.type !== "choice" ||
    typeof value.choice !== "string" ||
    value.choice.length === 0 ||
    !isProbability(value.confidence) ||
    !isRecord(value.probabilities)
  ) {
    throw new RunLiveError(`${context}: malformed choice answer`);
  }
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(value.probabilities)) {
    if (!isProbability(probability)) {
      throw new RunLiveError(`${context}: probability for ${label} out of range`);
    }
    probabilities[label] = probability;
  }
  return { choice: value.choice, confidence: value.confidence, probabilities };
};

const parseUsage = (value: unknown): Usage => ({
  inputTokens:
    isRecord(value) && Number.isInteger(value.input_tokens)
      ? (value.input_tokens as number)
      : 0,
  outputTokens:
    isRecord(value) && Number.isInteger(value.output_tokens)
      ? (value.output_tokens as number)
      : 0,
});

interface SystemOneLikeResult {
  readonly model?: unknown;
  readonly answers?: unknown;
  readonly usage?: unknown;
}

/** Map a raw systemOne response into scorer-format claim rows for one case. */
export const mapVerifyResponse = (
  corpusCase: CorpusCase,
  response: SystemOneLikeResult,
  latencyMs: number,
): Omit<CaseWireResult, "model"> => {
  const answers = isRecord(response) && isRecord(response.answers) ? response.answers : {};
  const claimItems = ensureUniqueIds(
    corpusCase.claims.map((text): { id?: string; text: string } => ({ text })),
    "claim",
  );
  const results: ClaimWireResult[] = claimItems.map((claim, claimIndex) => {
    const context = `${corpusCase.id}.claims[${claimIndex}]`;
    const relation = parseChoiceAnswer(
      answers[`relation_${claim.id}`],
      `${context}.relation`,
    );
    const verdict = RELATION_TO_VERDICT[relation.choice];
    if (verdict === undefined) {
      throw new RunLiveError(`${context}: unknown relation choice ${relation.choice}`);
    }
    const probabilities = {} as Record<Verdict, number>;
    for (const label of RELATION_LABELS) {
      const probability = relation.probabilities[label];
      if (probability === undefined) {
        throw new RunLiveError(`${context}: missing probability for ${label}`);
      }
      probabilities[RELATION_TO_VERDICT[label] as Verdict] = probability;
    }
    const source = answers[`source_${claim.id}`];
    const supportingEvidence =
      isRecord(source) && typeof source.choice === "string" && source.choice !== "none"
        ? source.choice
        : null;
    return {
      claim_index: claimIndex,
      verdict,
      probabilities,
      confidence: relation.confidence,
      action: verifyAction(relation.confidence, TOOL_DEFAULT_AUTO_ACCEPT),
      supporting_evidence: supportingEvidence,
    };
  });
  const usage = parseUsage(isRecord(response) ? response.usage : undefined);
  return {
    case_id: corpusCase.id,
    results,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    latency_ms: Math.round(latencyMs),
  };
};

interface CliOptions {
  readonly corpus: string;
  readonly results: string;
  readonly errors: string;
  readonly model: string;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly limit: number | null;
}

const USAGE = [
  "usage: run-live.js [--corpus <dir>] [--results <file>] [--errors <file>]",
  "                   [--model <name>] [--max-calls <n>] [--max-input-tokens <n>]",
  "                   [--limit <n>]",
  "defaults resolve against the repository root:",
  "  --corpus   arena/done-gate/corpus",
  "  --results  arena/done-gate/results/live-<utc-date>.jsonl",
  "  --errors   <results with .errors.jsonl suffix>",
].join("\n");

const takeValue = (argv: readonly string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RunLiveError(`cli: ${flag} requires a value`);
  }
  return value;
};

const takePositiveInt = (
  argv: readonly string[],
  index: number,
  flag: string,
): number => {
  const raw = takeValue(argv, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RunLiveError(`cli: ${flag} requires a positive integer, got ${raw}`);
  }
  return value;
};

export const utcDateStamp = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

export const parseArgs = (
  argv: readonly string[],
  root: string = DEFAULT_ROOT,
): CliOptions => {
  let corpus: string | null = null;
  let results: string | null = null;
  let errors: string | null = null;
  let model = DEFAULT_MODEL;
  let maxCalls = DEFAULT_MAX_CALLS;
  let maxInputTokens = DEFAULT_MAX_INPUT_TOKENS;
  let limit: number | null = null;
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
      case "--errors":
        errors = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--model":
        model = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--max-calls":
        maxCalls = takePositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--max-input-tokens":
        maxInputTokens = takePositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        limit = takePositiveInt(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        throw new RunLiveError(USAGE);
      default:
        throw new RunLiveError(`cli: unknown argument ${String(arg)}\n${USAGE}`);
    }
  }
  const absolutize = (path: string | null, fallback: string): string => {
    if (path === null) {
      return fallback;
    }
    return isAbsolute(path) ? path : resolve(process.cwd(), path);
  };
  const resultsPath = absolutize(
    results,
    join(root, "arena/done-gate/results", `live-${utcDateStamp()}.jsonl`),
  );
  const errorsPath = absolutize(
    errors,
    resultsPath.replace(/\.jsonl$/, "") + ".errors.jsonl",
  );
  return {
    corpus: absolutize(corpus, join(root, "arena/done-gate/corpus")),
    results: resultsPath,
    errors: errorsPath,
    model,
    maxCalls,
    maxInputTokens,
    limit,
  };
};

/** Case ids already recorded in an existing results file (resume support). */
export const loadCoveredCaseIds = (resultsPath: string): ReadonlySet<string> => {
  if (!existsSync(resultsPath)) {
    return new Set();
  }
  const covered = new Set<string>();
  for (const [index, line] of readFileSync(resultsPath, "utf8").split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new RunLiveError(`results: ${resultsPath}:${index + 1}: invalid JSON line`);
    }
    if (!isRecord(value) || typeof value.case_id !== "string") {
      throw new RunLiveError(`results: ${resultsPath}:${index + 1}: missing case_id`);
    }
    covered.add(value.case_id);
  }
  return covered;
};

export interface RunSummary {
  readonly resultsPath: string;
  readonly errorsPath: string;
  readonly calls: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly stoppedBy: "completed" | "max-calls" | "input-tokens";
}

export const runLive = async (options: CliOptions): Promise<RunSummary> => {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new RunLiveError("TYPESAFE_API_KEY is not set");
  }
  const cases = loadCorpus(options.corpus);
  const covered = loadCoveredCaseIds(options.results);
  for (const directory of [dirname(options.results), dirname(options.errors)]) {
    mkdirSync(directory, { recursive: true });
  }
  // Same client shape as jev-mcp 0.5.0 provider.js: env key, optional base URL,
  // SDK-default timeout (10s) and retries (2). apiKey is passed explicitly
  // because it was validated above; behavior is identical.
  const client = new TypeSafeClient({
    apiKey,
    ...(process.env.TYPESAFE_BASE_URL?.trim()
      ? { baseURL: process.env.TYPESAFE_BASE_URL.trim() }
      : {}),
    logLevel: "off",
  });

  let calls = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let stoppedBy: RunSummary["stoppedBy"] = "completed";

  for (const corpusCase of cases) {
    if (options.limit !== null && ok + failed >= options.limit) {
      break;
    }
    if (covered.has(corpusCase.id)) {
      skipped += 1;
      continue;
    }
    if (calls >= options.maxCalls || inputTokens >= options.maxInputTokens) {
      stoppedBy = calls >= options.maxCalls ? "max-calls" : "input-tokens";
      break;
    }
    calls += 1;
    const { state, questions } = buildVerifyRequest(corpusCase);
    const started = performance.now();
    try {
      const response: SystemOneLikeResult = await client.systemOne({
        state,
        questions,
        model: options.model,
      });
      const latencyMs = performance.now() - started;
      const row = mapVerifyResponse(corpusCase, response, latencyMs);
      const model =
        isRecord(response) && typeof response.model === "string" && response.model
          ? response.model
          : options.model;
      const line: CaseWireResult = { ...row, model };
      appendFileSync(options.results, `${JSON.stringify(line)}\n`, "utf8");
      inputTokens += row.usage.input_tokens;
      outputTokens += row.usage.output_tokens;
      ok += 1;
      console.log(
        `ok ${corpusCase.id} claims=${row.results.length} ` +
          `in=${row.usage.input_tokens} out=${row.usage.output_tokens} ` +
          `${row.latency_ms}ms cumulative_in=${inputTokens}`,
      );
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const entry: CaseError = {
        case_id: corpusCase.id,
        error: message,
        latency_ms: latencyMs,
      };
      appendFileSync(options.errors, `${JSON.stringify(entry)}\n`, "utf8");
      failed += 1;
      console.log(`error ${corpusCase.id} ${message} ${latencyMs}ms`);
    }
  }
  return {
    resultsPath: options.results,
    errorsPath: options.errors,
    calls,
    ok,
    failed,
    skipped,
    inputTokens,
    outputTokens,
    stoppedBy,
  };
};

const isMain = ((): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
})();

if (isMain) {
  runLive(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      const costUsd =
        (summary.inputTokens / 1_000_000) * INPUT_USD_PER_MILLION +
        (summary.outputTokens / 1_000_000) * OUTPUT_USD_PER_MILLION;
      console.log(
        `done: ${summary.ok} ok / ${summary.failed} errors / ${summary.skipped} skipped ` +
          `(${summary.calls} calls, stopped by ${summary.stoppedBy}); ` +
          `tokens in=${summary.inputTokens} out=${summary.outputTokens} ` +
          `(~$${costUsd.toFixed(4)}); results=${summary.resultsPath} errors=${summary.errorsPath}`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
