/**
 * Extracts (question -> owner answer) pairs from local Claude Code session
 * journals (`~/.claude/projects/**` JSONL) into a private calibration corpus.
 *
 * Privacy: the corpus holds personal sessions, so it is written only under
 * `~/.local/state/autopilot-calib/`, never into the repository. Context for a
 * pair (goal, tail) is snapshotted from lines BEFORE the tool_use, so the
 * owner's answer never reaches it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PairOption {
  readonly label: string;
  readonly description: string;
}

export interface Pair {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly question: string;
  readonly options: readonly PairOption[];
  readonly answer: { readonly idx: number; readonly label: string };
  readonly recommendedIdx: number | null;
  readonly goal: string;
  readonly tail: string;
}

export const SKIP_REASONS = [
  "error",
  "afk",
  "no_result",
  "multiSelect",
  "unanswered",
  "free_text",
  "duplicate",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface Stats {
  calls: number;
  questions: number;
  pairs: number;
  skipped: Record<SkipReason, number>;
}

export interface Shared {
  readonly seenCalls: Set<string>;
  readonly seenPairs: Set<string>;
  readonly stats: Stats;
  readonly pairs: Pair[];
}

export const GOAL_MAX = 500;
export const TAIL_MAX = 2000;
const TAIL_KEEP = 4000;
/** The assistant's own pick marker, English or Russian; shared with calibrate.ts. */
export const HINT = /\s*\((?:Recommended|Рекомендую|Рекомендуется)\)/iu;

export const stateDir = (): string => join(homedir(), ".local", "state", "autopilot-calib");

/** Private state: owner-only directory and files, also tightened when they already exist. */
export const privateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};
export const writePrivate = (path: string, text: string): void => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};
export const appendPrivate = (path: string, text: string): void => {
  appendFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export const writeCorpus = (dir: string, pairs: readonly Pair[]): void => {
  privateDir(dir);
  writePrivate(join(dir, "corpus.jsonl"), pairs.map((pair) => `${JSON.stringify(pair)}\n`).join(""));
};

export const newShared = (): Shared => ({
  seenCalls: new Set(),
  seenPairs: new Set(),
  stats: {
    calls: 0,
    questions: 0,
    pairs: 0,
    skipped: { error: 0, afk: 0, no_result: 0, multiSelect: 0, unanswered: 0, free_text: 0, duplicate: 0 },
  },
  pairs: [],
});

type Json = Record<string, unknown>;
const isObj = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

const blocksOf = (line: Json): Json[] => {
  const content = isObj(line["message"]) ? line["message"]["content"] : undefined;
  return Array.isArray(content) ? content.filter(isObj) : [];
};

/** The owner's own typed message (not a tool result, hook or system note), or undefined. */
export const realUserText = (line: Json): string | undefined => {
  if (line["type"] !== "user" || line["isMeta"] === true || line["toolUseResult"] !== undefined) {
    return undefined;
  }
  const message = isObj(line["message"]) ? line["message"] : {};
  const content = message["content"];
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const blocks = content.filter(isObj);
    if (blocks.some((block) => block["type"] === "tool_result")) {
      return undefined;
    }
    text = blocks.filter((block) => block["type"] === "text").map((block) => str(block["text"])).join("\n");
  } else {
    return undefined;
  }
  text = text.trim();
  return text === "" || text.startsWith("<") || text.startsWith("[Request interrupted") ? undefined : text;
};

interface Pending {
  readonly ts: string;
  readonly goal: string;
  readonly tail: string;
  readonly questions: readonly Json[];
}

const pairId = (question: string, answer: string): string =>
  createHash("sha256").update(`${question}\0${answer}`).digest("hex").slice(0, 12);

const optionsOf = (question: Json): PairOption[] =>
  (Array.isArray(question["options"]) ? question["options"] : [])
    .filter(isObj)
    .map((option) => ({ label: str(option["label"]), description: str(option["description"]) }));

const skip = (shared: Shared, reason: SkipReason, count = 1): void => {
  shared.stats.skipped[reason] += count;
};

/**
 * Walks one journal top to bottom. `goal` and `tail` are snapshotted when the
 * AskUserQuestion tool_use is read, so everything after it (the answer) is out.
 */
export const extractLines = (lines: Iterable<string>, sessionId: string, shared: Shared): void => {
  const pending = new Map<string, Pending>();
  let goal = "";
  let tail = "";

  for (const raw of lines) {
    if (raw === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(line)) continue;

    const user = realUserText(line);
    if (user !== undefined) {
      goal = user.slice(0, GOAL_MAX);
      tail = "";
      continue;
    }
    const ts = str(line["timestamp"]);

    if (line["type"] === "assistant") {
      for (const block of blocksOf(line)) {
        if (block["type"] === "text") {
          tail = `${tail}${str(block["text"])}\n`.slice(-TAIL_KEEP);
        } else if (block["type"] === "tool_use" && block["name"] === "AskUserQuestion") {
          const id = str(block["id"]);
          if (id === "" || shared.seenCalls.has(id)) continue;
          shared.seenCalls.add(id);
          const input = isObj(block["input"]) ? block["input"] : {};
          const questions = Array.isArray(input["questions"]) ? input["questions"].filter(isObj) : [];
          shared.stats.calls += 1;
          shared.stats.questions += questions.length;
          pending.set(id, { ts, goal, tail: tail.trim().slice(-TAIL_MAX), questions });
        }
      }
      continue;
    }

    for (const block of blocksOf(line)) {
      if (block["type"] !== "tool_result") continue;
      const call = pending.get(str(block["tool_use_id"]));
      if (call === undefined) continue;
      pending.delete(str(block["tool_use_id"]));
      const result = line["toolUseResult"];
      if (block["is_error"] === true || !isObj(result)) {
        skip(shared, "error", call.questions.length);
      } else if (result["afkTimeoutMs"] !== undefined) {
        skip(shared, "afk", call.questions.length);
      } else {
        const answers = isObj(result["answers"]) ? result["answers"] : {};
        for (const question of call.questions) addPair(shared, sessionId, call, question, answers);
      }
    }
  }
  for (const call of pending.values()) skip(shared, "no_result", call.questions.length);
};

const addPair = (shared: Shared, sessionId: string, call: Pending, question: Json, answers: Json): void => {
  const text = str(question["question"]);
  if (question["multiSelect"] === true) return skip(shared, "multiSelect");
  const answer = answers[text];
  if (typeof answer !== "string" || answer === "") return skip(shared, "unanswered");
  const options = optionsOf(question);
  const idx = options.findIndex((option) => option.label === answer);
  if (idx < 0) return skip(shared, "free_text");
  const key = `${text}\0${answer}`;
  if (shared.seenPairs.has(key)) return skip(shared, "duplicate");
  shared.seenPairs.add(key);
  const recommended = options.findIndex((option) => HINT.test(option.label));
  shared.pairs.push({
    id: pairId(text, answer),
    sessionId,
    ts: call.ts,
    question: text,
    options,
    answer: { idx, label: answer },
    recommendedIdx: recommended < 0 ? null : recommended,
    goal: call.goal,
    tail: call.tail,
  });
  shared.stats.pairs += 1;
};

const jsonlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

/** Reads every journal under `projectsDir`; files without an AskUserQuestion call are skipped unparsed. */
export const extractAll = (projectsDir: string): Shared => {
  const shared = newShared();
  for (const file of jsonlFiles(projectsDir)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes('"name":"AskUserQuestion"')) continue;
    extractLines(text.split("\n"), basename(file, ".jsonl"), shared);
  }
  return shared;
};

const main = (): void => {
  const shared = extractAll(join(homedir(), ".claude", "projects"));
  writeCorpus(stateDir(), shared.pairs);
  const { stats } = shared;
  console.log(`tool calls: ${stats.calls}`);
  console.log(`questions: ${stats.questions}`);
  for (const reason of SKIP_REASONS) console.log(`skipped ${reason}: ${stats.skipped[reason]}`);
  console.log(`pairs: ${stats.pairs}`);
};

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main();
