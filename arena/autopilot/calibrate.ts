/**
 * Calibration of an "autopilot" that picks an AskUserQuestion option for the
 * owner: asks a local Kev (System One `choice`) for each corpus pair and
 * measures, per confidence threshold, how much it would answer on its own
 * (coverage) and how often that matches the owner (agreement).
 *
 * Privacy: the corpus and per-row results stay in `~/.local/state/autopilot-calib/`.
 * Only the aggregate report (numbers, no question or answer text) is written
 * into the repository.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HINT, stateDir, type Pair } from "./extract.js";

export const VARIANTS = ["asis", "stripped"] as const;
export type Variant = (typeof VARIANTS)[number];

export const KEV_URL = "http://127.0.0.1:8010";
const STATE_MAX = 8000;
const TIMEOUT_MS = 60_000;
const EPS = 1e-9;
export const T_GRID = Array.from({ length: 10 }, (_, i) => Math.round((0.5 + 0.05 * i) * 100) / 100);
export const M_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
export const TARGET_AGREEMENT = 0.9;
export const TARGET_COVERAGE = 0.4;
export const FRAGILE_WILSON = 0.8;

// ---------------------------------------------------------------- request

/** The hint is removed from labels so Kev cannot read the assistant's own pick. */
export const stripHint = (label: string): string =>
  label.replace(new RegExp(HINT.source, "giu"), "").trim();

export const stateOf = (pair: Pick<Pair, "goal" | "tail" | "question">): string =>
  `Owner goal: ${pair.goal}\n\nAssistant said:\n${pair.tail}\n\nQuestion: ${pair.question}`.slice(-STATE_MAX);

/** Unique criteria keys (a repeated label gets its index) and their option index. */
export const criteriaOf = (
  pair: Pick<Pair, "options">,
  variant: Variant,
): { keys: string[]; criteria: Record<string, string> } => {
  const keys: string[] = [];
  const criteria: Record<string, string> = {};
  pair.options.forEach((option, index) => {
    const label = variant === "stripped" ? stripHint(option.label) : option.label;
    const key = keys.includes(label) ? `${label} #${index + 1}` : label;
    keys.push(key);
    criteria[key] = option.description === "" ? label : option.description;
  });
  return { keys, criteria };
};

export const bodyOf = (pair: Pair, variant: Variant): { body: string; keys: string[] } => {
  const { keys, criteria } = criteriaOf(pair, variant);
  const body = JSON.stringify({
    model: "kev-latest",
    state: stateOf(pair),
    questions: { pick: { type: "choice", instructions: "Which option would this owner choose?", criteria } },
  });
  return { body, keys };
};

export interface Row {
  readonly id: string;
  readonly variant: Variant;
  readonly sessionId: string;
  readonly nOptions: number;
  readonly ownerIdx: number;
  readonly pickIdx: number;
  readonly p1: number;
  readonly p2: number;
  readonly margin: number;
  readonly recommendedIdx: number | null;
  readonly latencyMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Top-1 index, p1 and p2 from a System One answer; throws when the shape is off. */
export const readPick = (
  body: unknown,
  keys: readonly string[],
): { pickIdx: number; p1: number; p2: number } => {
  const answers = isRecord(body) ? body["answers"] : undefined;
  const pick = isRecord(answers) ? answers["pick"] : undefined;
  const probabilities = isRecord(pick) ? pick["probabilities"] : undefined;
  if (!isRecord(probabilities)) throw new Error("no answers.pick.probabilities in response");
  const values = keys.map((key) => probabilities[key]);
  if (!values.every((value): value is number => typeof value === "number")) {
    throw new Error("probabilities do not cover every option");
  }
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value || a.index - b.index);
  const first = order[0];
  const second = order[1];
  if (first === undefined) throw new Error("no options");
  return { pickIdx: first.index, p1: first.value, p2: second?.value ?? 0 };
};

// ---------------------------------------------------------------- analytics

export interface Scored {
  readonly sessionId: string;
  readonly p1: number;
  readonly margin: number;
  readonly hit: boolean;
}

export interface Cell {
  readonly T: number;
  readonly M: number;
  readonly auto: number;
  readonly coverage: number;
  readonly agreement: number | null;
  readonly wilsonLow: number | null;
}

/** Lower bound of the Wilson score interval for k successes out of n. */
export const wilsonLow = (k: number, n: number, z = 1.96): number => {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - spread) / (1 + z2 / n));
};

export const cellOf = (rows: readonly Scored[], T: number, M: number): Cell => {
  const chosen = rows.filter((row) => row.p1 >= T - EPS && row.margin >= M - EPS);
  const hits = chosen.filter((row) => row.hit).length;
  return {
    T,
    M,
    auto: chosen.length,
    coverage: rows.length === 0 ? 0 : chosen.length / rows.length,
    agreement: chosen.length === 0 ? null : hits / chosen.length,
    wilsonLow: chosen.length === 0 ? null : wilsonLow(hits, chosen.length),
  };
};

export const gridOf = (rows: readonly Scored[]): Cell[] =>
  T_GRID.flatMap((T) => M_GRID.map((M) => cellOf(rows, T, M)));

export const passes = (cell: Cell): boolean =>
  cell.agreement !== null && cell.agreement >= TARGET_AGREEMENT - EPS && cell.coverage >= TARGET_COVERAGE - EPS;

/** Passing cell with the most coverage; on a tie, the lower risk (higher agreement). */
export const selectCell = (cells: readonly Cell[]): Cell | null => {
  let best: Cell | null = null;
  for (const cell of cells.filter(passes)) {
    if (
      best === null ||
      cell.coverage > best.coverage + EPS ||
      (Math.abs(cell.coverage - best.coverage) <= EPS && (cell.agreement ?? 0) > (best.agreement ?? 0) + EPS)
    ) {
      best = cell;
    }
  }
  return best;
};

/** Deterministic 0/1 half of a session. */
export const halfOf = (sessionId: string): 0 | 1 =>
  parseInt(createHash("sha256").update(sessionId).digest("hex").slice(0, 8), 16) % 2 === 0 ? 0 : 1;

export interface HoldoutDirection {
  readonly trainHalf: 0 | 1;
  readonly nTrain: number;
  readonly nTest: number;
  readonly selected: Cell | null;
  readonly test: Cell | null;
  readonly confirmed: boolean;
}

/** Pick (T, M) on one half of the sessions, evaluate on the other, and vice versa. */
export const holdoutOf = (rows: readonly Scored[]): HoldoutDirection[] =>
  ([0, 1] as const).map((trainHalf) => {
    const train = rows.filter((row) => halfOf(row.sessionId) === trainHalf);
    const held = rows.filter((row) => halfOf(row.sessionId) !== trainHalf);
    const selected = selectCell(gridOf(train));
    const test = selected === null ? null : cellOf(held, selected.T, selected.M);
    const confirmed = test !== null && test.agreement !== null && test.agreement >= TARGET_AGREEMENT - EPS;
    return { trainHalf, nTrain: train.length, nTest: held.length, selected, test, confirmed };
  });

export interface Baselines {
  readonly n: number;
  readonly recommended: { readonly pairs: number; readonly agreement: number | null };
  readonly first: number;
  readonly majority: { readonly idx: number; readonly agreement: number };
  readonly kevTop1: number;
}

/** Baseline agreement with the owner: the assistant's (Recommended), first option, modal answer index, Kev top-1. */
export const baselinesOf = (rows: readonly Row[]): Baselines => {
  const n = rows.length;
  const share = (count: number, of: number): number => (of === 0 ? 0 : count / of);
  const withHint = rows.filter((row) => row.recommendedIdx !== null);
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.ownerIdx, (counts.get(row.ownerIdx) ?? 0) + 1);
  const [idx = 0, top = 0] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [];
  return {
    n,
    recommended: {
      pairs: withHint.length,
      agreement: withHint.length === 0 ? null : share(withHint.filter((row) => row.recommendedIdx === row.ownerIdx).length, withHint.length),
    },
    first: share(rows.filter((row) => row.ownerIdx === 0).length, n),
    majority: { idx, agreement: share(top, n) },
    kevTop1: share(rows.filter((row) => row.pickIdx === row.ownerIdx).length, n),
  };
};

export const scoredOf = (rows: readonly Row[]): Scored[] =>
  rows.map((row) => ({ sessionId: row.sessionId, p1: row.p1, margin: row.margin, hit: row.pickIdx === row.ownerIdx }));

export interface Verdict {
  readonly kind: "auto" | "hint";
  readonly cell: Cell | null;
  readonly fragile: boolean;
}

export const verdictOf = (rows: readonly Row[]): Verdict => {
  const scored = scoredOf(rows);
  const cell = selectCell(gridOf(scored));
  if (cell === null) return { kind: "hint", cell: null, fragile: false };
  // A cell picked and scored on the same pairs is only trusted when the hold-out confirms it.
  if (!holdoutOf(scored).every((direction) => direction.confirmed)) return { kind: "hint", cell, fragile: true };
  return { kind: "auto", cell, fragile: (cell.wilsonLow ?? 0) < FRAGILE_WILSON };
};

export const breakdownOf = (rows: readonly Row[]): Map<number, number> => {
  const out = new Map<number, number>();
  for (const row of rows) out.set(row.nOptions, (out.get(row.nOptions) ?? 0) + 1);
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
};

export const latencyOf = (rows: readonly Row[]): { mean: number; median: number; p95: number } => {
  const sorted = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  if (sorted.length === 0) return { mean: 0, median: 0, p95: 0 };
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: at(0.5), p95: at(0.95) };
};

// ---------------------------------------------------------------- report

const pct = (value: number | null, digits = 0): string => (value === null ? "-" : `${(value * 100).toFixed(digits)}%`);

const tableOf = (rows: readonly Row[]): string => {
  const cells = gridOf(scoredOf(rows));
  const header = `| T \\ M | ${M_GRID.map((M) => M.toFixed(1)).join(" | ")} |`;
  const rule = `|---|${M_GRID.map(() => "---").join("|")}|`;
  const lines = T_GRID.map((T) => {
    const cols = M_GRID.map((M) => {
      const cell = cells.find((candidate) => candidate.T === T && candidate.M === M);
      if (cell === undefined) return "";
      const text = `${pct(cell.coverage)} / ${pct(cell.agreement)} (${cell.auto})`;
      return passes(cell) ? `**${text}**` : text;
    });
    return `| ${T.toFixed(2)} | ${cols.join(" | ")} |`;
  });
  return [header, rule, ...lines].join("\n");
};

const cellText = (cell: Cell | null): string =>
  cell === null
    ? "none"
    : `T=${cell.T.toFixed(2)}, M=${cell.M.toFixed(1)}: auto ${cell.auto}, coverage ${pct(cell.coverage, 1)}, agreement ${pct(cell.agreement, 1)}, Wilson low ${pct(cell.wilsonLow, 1)}`;

export interface KevInfo {
  readonly description: string;
  readonly run: string;
}

export interface ReportInput {
  readonly date: string;
  readonly rows: Readonly<Record<Variant, readonly Row[]>>;
  readonly errors: Readonly<Record<Variant, number>>;
  readonly corpusSize: number;
  readonly kev: KevInfo;
}

export const verdictLine = (verdict: Verdict): string =>
  verdict.kind === "hint"
    ? "только hint"
    : `T=${verdict.cell?.T.toFixed(2)}, M=${verdict.cell?.M.toFixed(1)}${verdict.fragile ? " (хрупко)" : ""}`;

export const renderReport = (input: ReportInput): string => {
  const out: string[] = [];
  const asis = input.rows.asis;
  const verdicts = Object.fromEntries(VARIANTS.map((variant) => [variant, verdictOf(input.rows[variant])])) as Record<Variant, Verdict>;
  out.push(`# Autopilot calibration ${input.date}`, "");
  out.push(
    `Goal: agreement >= ${pct(TARGET_AGREEMENT)} at coverage >= ${pct(TARGET_COVERAGE)}, otherwise the autopilot stays a hint.`,
    "",
    "## Verdict",
    "",
    `**${verdictLine(verdicts.asis)}** (variant \`asis\`, the deployment condition: labels as the assistant wrote them).`,
    `Variant \`stripped\` (Kev cannot see the (Recommended) hint): **${verdictLine(verdicts.stripped)}**.`,
    "",
    "A cell passes when agreement >= 90% and coverage >= 40%; the pick is the passing cell with the most coverage, then the higher agreement. \"Fragile\" means the Wilson 95% lower bound is below 0.80 or the cross-half hold-out does not confirm >= 90%.",
    "",
    "## Data",
    "",
    `- corpus pairs: ${input.corpusSize}; scored: ${VARIANTS.map((variant) => `${variant} ${input.rows[variant].length} (errors ${input.errors[variant]})`).join(", ")}`,
    `- by number of options (asis): ${[...breakdownOf(asis)].map(([n, count]) => `${n} options: ${count}`).join("; ")}`,
    `- Kev: ${input.kev.run}; ${input.kev.description}`,
    ...VARIANTS.map((variant) => {
      const latency = latencyOf(input.rows[variant]);
      return `- Kev latency, ${variant}: mean ${latency.mean.toFixed(0)} ms, median ${latency.median.toFixed(0)} ms, p95 ${latency.p95.toFixed(0)} ms`;
    }),
    "- For 2-option questions margin = 2*p1 - 1, so T and M are redundant there; the grid mixes them with 3+ option questions.",
    "",
  );
  for (const variant of VARIANTS) {
    const rows = input.rows[variant];
    const base = baselinesOf(rows);
    const scored = scoredOf(rows);
    out.push(
      `## Variant ${variant}`,
      "",
      `Cell: coverage / agreement (auto count). Bold: passes the target. N = ${rows.length}.`,
      "",
      tableOf(rows),
      "",
      `Selected: ${cellText(verdicts[variant].cell)}`,
      "",
      "Baselines (agreement with the owner):",
      "",
      `- always (Recommended): ${pct(base.recommended.agreement, 1)} on the ${base.recommended.pairs} of ${base.n} pairs that carry the label (coverage ${pct(base.n === 0 ? 0 : base.recommended.pairs / base.n, 1)})`,
      `- always the first option: ${pct(base.first, 1)}`,
      `- corpus majority (option index ${base.majority.idx + 1}): ${pct(base.majority.agreement, 1)}`,
      `- Kev top-1, no threshold: ${pct(base.kevTop1, 1)}`,
      "",
      "Hold-out (sessions split into two halves by hash; pick on one half, evaluate on the other):",
      "",
    );
    for (const direction of holdoutOf(scored)) {
      out.push(
        `- train half ${direction.trainHalf} (${direction.nTrain} pairs) -> test (${direction.nTest} pairs): picked ${cellText(direction.selected)}; on test ${direction.test === null ? "no cell to evaluate" : cellText(direction.test)}; confirmed >= 90%: ${direction.confirmed ? "yes" : "no"}`,
      );
    }
    out.push("");
  }
  out.push(
    "## Limits",
    "",
    "- One owner, one corpus of a few dozen pairs: confidence intervals are wide, so a passing cell is an estimate, not a guarantee.",
    "- Pairs are extracted from past sessions; the answer to an earlier question can shape later ones, so pairs are not independent.",
    "- Multi-select, free-text, timed-out and refused questions are excluded, so the autopilot is calibrated only for single-choice questions.",
    "- Kev sees the goal and the assistant's closing text, trimmed to a fixed size, not the whole session; owner messages that start with `<` (slash commands, pasted blocks) are dropped, so the goal is short or empty for about half of the pairs. The verdict is \"Kev with this state is not calibrated\", not \"Kev cannot\".",
    "- The model and its serving temperature are those reported above; a different Kev revision needs a new run.",
    "",
  );
  return out.join("\n");
};

// ---------------------------------------------------------------- run

const readJsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as T)
    : [];

export class KevDownError extends Error {}

export const kevInfoOf = async (kevUrl: string): Promise<KevInfo> => {
  let body: unknown;
  try {
    const response = await fetch(`${kevUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new KevDownError(
      `Kev does not answer at ${kevUrl} (${error instanceof Error ? error.message : String(error)}); start it first, this script never starts a server`,
    );
  }
  const models = isRecord(body) && Array.isArray(body["models"]) ? body["models"].filter(isRecord) : [];
  const model = models.find((candidate) => candidate["name"] === "kev-latest") ?? models[0] ?? {};
  return { description: String(model["description"] ?? "unknown"), run: String(model["run"] ?? "unknown") };
};

export interface RunOptions {
  readonly dir: string;
  readonly kevUrl: string;
  readonly resultsDir: string;
  readonly date: string;
  readonly log?: (message: string) => void;
}

export const runCalibration = async (options: RunOptions): Promise<{ reportPath: string; input: ReportInput }> => {
  const log = options.log ?? (() => undefined);
  const kev = await kevInfoOf(options.kevUrl);
  const corpus = readJsonl<Pair>(join(options.dir, "corpus.jsonl"));
  if (corpus.length === 0) throw new Error(`empty corpus: run autopilot:extract first (${options.dir})`);
  const errorsPath = join(options.dir, "errors.jsonl");
  const rows = { asis: [] as Row[], stripped: [] as Row[] };
  const errors = { asis: 0, stripped: 0 };

  for (const variant of VARIANTS) {
    const rowsPath = join(options.dir, `rows-${variant}.jsonl`);
    rows[variant] = readJsonl<Row>(rowsPath);
    const done = new Set(rows[variant].map((row) => row.id));
    for (const pair of corpus) {
      if (done.has(pair.id)) continue;
      const { body, keys } = bodyOf(pair, variant);
      const started = performance.now();
      try {
        const response = await fetch(`${options.kevUrl}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json: unknown = await response.json();
        const wall = performance.now() - started;
        const reported = isRecord(json) && typeof json["latency_ms"] === "number" ? json["latency_ms"] : wall;
        const pick = readPick(json, keys);
        const finished: Row = {
          id: pair.id,
          variant,
          sessionId: pair.sessionId,
          nOptions: pair.options.length,
          ownerIdx: pair.answer.idx,
          ...pick,
          margin: pick.p1 - pick.p2,
          recommendedIdx: pair.recommendedIdx,
          latencyMs: reported,
        };
        appendFileSync(rowsPath, `${JSON.stringify(finished)}\n`);
        rows[variant].push(finished);
        log(`${variant} ${rows[variant].length}/${corpus.length}`);
      } catch (error) {
        errors[variant] += 1;
        const message = error instanceof Error ? error.message : String(error);
        appendFileSync(errorsPath, `${JSON.stringify({ id: pair.id, variant, error: message, at: new Date().toISOString() })}\n`);
        log(`${variant} error: ${message}`);
      }
    }
  }
  if (rows.asis.length === 0 || rows.stripped.length === 0) {
    throw new Error(`no scored rows (errors in ${errorsPath}); the report was not written`);
  }
  const input: ReportInput = { date: options.date, rows, errors, corpusSize: corpus.length, kev };
  mkdirSync(options.resultsDir, { recursive: true });
  const reportPath = join(options.resultsDir, `calibration-${options.date}.md`);
  writeFileSync(reportPath, renderReport(input));
  return { reportPath, input };
};

const main = async (): Promise<void> => {
  const { reportPath, input } = await runCalibration({
    dir: stateDir(),
    kevUrl: KEV_URL,
    resultsDir: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "arena", "autopilot", "results"),
    date: new Date().toISOString().slice(0, 10),
    log: console.log,
  });
  for (const variant of VARIANTS) console.log(`${variant}: ${verdictLine(verdictOf(input.rows[variant]))}`);
  console.log(`report: ${reportPath.slice(reportPath.lastIndexOf("arena/autopilot"))}`);
};

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
