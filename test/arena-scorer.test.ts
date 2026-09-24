import assert from "node:assert/strict";
import test from "node:test";
import type {
  ArenaCase,
  ArenaContestantId,
  ArenaGold,
  ArenaGoldRecord,
  ArenaResult,
  ArenaRisk,
  ArenaSkillManifest,
  ArenaStatus,
} from "../src/arena-contracts.js";
import {
  scoreArena,
  type ArenaContestantScore,
  type ArenaScoreboard,
} from "../src/arena-scorer.js";

const MANIFEST: ArenaSkillManifest = {
  skills: [
    { id: "alpha", description: "Skill alpha.", excerpt: "Alpha.", contextTokens: 100 },
    { id: "beta", description: "Skill beta.", excerpt: "Beta.", contextTokens: 200 },
    { id: "gamma", description: "Skill gamma.", excerpt: "Gamma.", contextTokens: 300 },
    { id: "delta", description: "Skill delta.", excerpt: "Delta.", contextTokens: 400 },
    { id: "epsilon", description: "Skill epsilon.", excerpt: "Epsilon.", contextTokens: 500 },
    { id: "zeta", description: "Skill zeta.", excerpt: "Zeta.", contextTokens: 600 },
    { id: "eta", description: "Skill eta.", excerpt: "Eta.", contextTokens: 700 },
    { id: "theta", description: "Skill theta.", excerpt: "Theta.", contextTokens: 800 },
  ],
};

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

const makeCase = (
  id: string,
  options: { explicit?: readonly string[]; required?: readonly string[]; risk?: ArenaRisk } = {},
): ArenaCase => {
  const explicit = options.explicit ?? [];
  const required = options.required ?? [];
  return {
    id,
    familyId: `fam-${id}`,
    language: "en",
    stratum: "bug",
    source: "synthetic",
    risk: options.risk ?? "standard",
    taskText: `Synthetic task ${id}.`,
    explicitSkillIds: sorted(explicit),
    requiredSkillIds: sorted(required),
    forcedSkillIds: sorted([...new Set([...explicit, ...required])]),
  };
};

const makeGold = (records: readonly ArenaGoldRecord[]): ArenaGold => ({
  records,
  provenance: {
    rubricVersion: "unit-rubric-v1",
    labelerRoles: ["annotator-a", "annotator-b"],
    adjudicatorRole: "adjudicator",
  },
});

const goldRecord = (
  caseId: string,
  acceptedRoutes: readonly (readonly string[])[],
  options: { mandatory?: readonly string[]; forbidden?: readonly string[] } = {},
): ArenaGoldRecord => ({
  caseId,
  acceptedRoutes: acceptedRoutes.map((route) => sorted(route)),
  mandatorySkillIds: sorted(options.mandatory ?? []),
  forbiddenSkillIds: sorted(options.forbidden ?? []),
});

const makeResult = (
  caseId: string,
  contestantId: ArenaContestantId,
  options: {
    status?: ArenaStatus;
    route?: readonly string[];
    reason?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number | null;
    costUsd?: number | null;
  } = {},
): ArenaResult => {
  const status = options.status ?? "ok";
  return {
    caseId,
    contestantId,
    status,
    selectedSkillIds: status === "ok" ? sorted(options.route ?? []) : [],
    reason: options.reason ?? (status === "ok" ? null : "unit-reason"),
    inputTokens: options.inputTokens ?? null,
    outputTokens: options.outputTokens ?? null,
    latencyMs: options.latencyMs ?? null,
    costUsd: options.costUsd ?? null,
  };
};

const fillerRuns = (
  contestantId: ArenaContestantId,
  cases: readonly ArenaCase[],
): ArenaResult[] =>
  cases.map((arenaCase) =>
    makeResult(arenaCase.id, contestantId, { status: "error", reason: "filler" })
  );

const score = (input: {
  cases: readonly ArenaCase[];
  gold: ArenaGold;
  jev?: readonly ArenaResult[];
  codex?: readonly ArenaResult[];
  rules?: readonly ArenaResult[];
}): ArenaScoreboard =>
  scoreArena({
    manifest: MANIFEST,
    cases: input.cases,
    gold: input.gold,
    runs: {
      jev: input.jev ?? fillerRuns("jev", input.cases),
      codex: input.codex ?? fillerRuns("codex", input.cases),
      rules: input.rules ?? fillerRuns("rules", input.cases),
    },
  });

const contestantScore = (
  board: ArenaScoreboard,
  contestantId: ArenaContestantId,
): ArenaContestantScore => {
  const entry = board.contestants.find((item) => item.contestantId === contestantId);
  assert.ok(entry !== undefined, `missing contestant ${contestantId}`);
  return entry;
};

const caseScore = (board: ArenaScoreboard, contestantId: ArenaContestantId, caseId: string) => {
  const entry = contestantScore(board, contestantId).cases.find((item) => item.caseId === caseId);
  assert.ok(entry !== undefined, `missing case ${caseId} for ${contestantId}`);
  return entry;
};

test("ok result matching any accepted optional route is scored correct", () => {
  const cases = [makeCase("c-1", { explicit: ["epsilon"] })];
  const gold = makeGold([
    goldRecord("c-1", [["alpha"], ["alpha", "beta"]], { mandatory: ["epsilon"] }),
  ]);
  const board = score({
    cases,
    gold,
    jev: [makeResult("c-1", "jev", { route: ["beta", "alpha", "epsilon"] })],
  });
  const entry = caseScore(board, "jev", "c-1");
  assert.equal(entry.status, "ok");
  assert.equal(entry.correct, true);
  assert.deepEqual(entry.effectiveRoute, ["alpha", "beta", "epsilon"]);
  assert.deepEqual(entry.optionalSelection, ["alpha", "beta"]);
  assert.deepEqual(entry.closestAcceptedRoute, ["alpha", "beta"]);
  assert.deepEqual(entry.falsePositives, []);
  assert.deepEqual(entry.falseNegatives, []);
  assert.equal(contestantScore(board, "jev").aggregates.accuracy, 1);

  const second = score({
    cases,
    gold,
    jev: [makeResult("c-1", "jev", { route: ["alpha", "epsilon"] })],
  });
  assert.equal(caseScore(second, "jev", "c-1").correct, true);
  assert.deepEqual(caseScore(second, "jev", "c-1").closestAcceptedRoute, ["alpha"]);
});

test("closest route minimizes FP+FN, then fewest FN, then lexicographic serialization", () => {
  const cases = [makeCase("c-1"), makeCase("c-2"), makeCase("c-3")];
  const gold = makeGold([
    goldRecord("c-1", [["alpha", "beta", "gamma"], ["delta"]]),
    goldRecord("c-2", [["beta"], ["alpha"]]),
    goldRecord("c-3", [["alpha", "beta"], ["gamma", "delta"]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      // |FP|+|FN| ties at 3 for both routes; fewest FN picks ["delta"].
      makeResult("c-1", "jev", { route: ["alpha", "zeta"] }),
      // Identical sums and FN; lexicographic serialization picks ["alpha"].
      makeResult("c-2", "jev", { route: ["zeta"] }),
      // Identical sums and FN; ["alpha","beta"] sorts before ["gamma","delta"].
      makeResult("c-3", "jev", { route: ["alpha", "gamma"] }),
    ],
  });
  const first = caseScore(board, "jev", "c-1");
  assert.deepEqual(first.closestAcceptedRoute, ["delta"]);
  assert.deepEqual(first.falsePositives, ["alpha", "zeta"]);
  assert.deepEqual(first.falseNegatives, ["delta"]);
  const second = caseScore(board, "jev", "c-2");
  assert.deepEqual(second.closestAcceptedRoute, ["alpha"]);
  assert.deepEqual(second.falsePositives, ["zeta"]);
  assert.deepEqual(second.falseNegatives, ["alpha"]);
  const third = caseScore(board, "jev", "c-3");
  assert.deepEqual(third.closestAcceptedRoute, ["alpha", "beta"]);
  assert.deepEqual(third.falsePositives, ["gamma"]);
  assert.deepEqual(third.falseNegatives, ["beta"]);
});

test("abstain and error are incorrect and count as empty optional selections", () => {
  const cases = [makeCase("c-1"), makeCase("c-2")];
  const gold = makeGold([
    goldRecord("c-1", [["alpha", "beta"]]),
    goldRecord("c-2", [[]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      makeResult("c-1", "jev", { status: "abstain", reason: "low-confidence" }),
      makeResult("c-2", "jev", { status: "error", reason: "adapter-failure" }),
    ],
  });
  const abstain = caseScore(board, "jev", "c-1");
  assert.equal(abstain.correct, false);
  assert.deepEqual(abstain.effectiveRoute, []);
  assert.deepEqual(abstain.optionalSelection, []);
  assert.deepEqual(abstain.falsePositives, []);
  assert.deepEqual(abstain.falseNegatives, ["alpha", "beta"]);
  const errored = caseScore(board, "jev", "c-2");
  assert.equal(errored.correct, false);
  assert.deepEqual(errored.falsePositives, []);
  assert.deepEqual(errored.falseNegatives, []);
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.equal(aggregates.accuracy, 0);
  assert.equal(aggregates.abstain, 1);
  assert.equal(aggregates.error, 1);
});

test("mandatory, high-risk mandatory, and forbidden hits are counted per skill", () => {
  const cases = [
    makeCase("c-1", { explicit: ["eta"], required: ["theta"] }),
    makeCase("c-2", { required: ["theta"], risk: "high" }),
    makeCase("c-3"),
  ];
  const gold = makeGold([
    goldRecord("c-1", [["alpha"]], { mandatory: ["eta", "theta"] }),
    goldRecord("c-2", [["alpha"]], { mandatory: ["theta"] }),
    goldRecord("c-3", [["alpha"]], { forbidden: ["zeta"] }),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      // Drops forced eta but keeps theta: one mandatory miss.
      makeResult("c-1", "jev", { route: ["alpha", "theta"] }),
      // Abstain on a high-risk case: mandatory theta is absent from the route.
      makeResult("c-2", "jev", { status: "abstain", reason: "low-confidence" }),
      // Effective route contains the forbidden skill: hit, and cannot be correct.
      makeResult("c-3", "jev", { route: ["alpha", "zeta"] }),
    ],
  });
  assert.deepEqual(caseScore(board, "jev", "c-1").missedMandatorySkillIds, ["eta"]);
  assert.equal(caseScore(board, "jev", "c-1").correct, true);
  assert.deepEqual(caseScore(board, "jev", "c-2").missedMandatorySkillIds, ["theta"]);
  assert.deepEqual(caseScore(board, "jev", "c-3").forbiddenHitSkillIds, ["zeta"]);
  assert.equal(caseScore(board, "jev", "c-3").correct, false);
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.equal(aggregates.mandatoryMisses, 2);
  assert.equal(aggregates.highRiskMandatoryMisses, 1);
  assert.equal(aggregates.forbiddenHits, 1);
});

test("zero-skill false-positive rate measures empty-route cases only", () => {
  const cases = [makeCase("z-1"), makeCase("z-2"), makeCase("n-1")];
  const gold = makeGold([
    goldRecord("z-1", [[]]),
    goldRecord("z-2", [[]]),
    goldRecord("n-1", [["alpha"]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      makeResult("z-1", "jev", { route: ["beta"] }),
      makeResult("z-2", "jev", { route: [] }),
      makeResult("n-1", "jev", { route: ["beta", "delta"] }),
    ],
  });
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.equal(aggregates.zeroSkillFalsePositiveRate, 0.5);

  const clean = score({
    cases,
    gold,
    jev: [
      makeResult("z-1", "jev", { route: [] }),
      makeResult("z-2", "jev", { route: [] }),
      makeResult("n-1", "jev", { route: ["alpha"] }),
    ],
  });
  assert.equal(contestantScore(clean, "jev").aggregates.zeroSkillFalsePositiveRate, 0);

  const none = score({
    cases: [cases[2]!],
    gold: makeGold([goldRecord("n-1", [["alpha"]])]),
    jev: [makeResult("n-1", "jev", { route: ["alpha"] })],
  });
  assert.equal(contestantScore(none, "jev").aggregates.zeroSkillFalsePositiveRate, null);
});

test("micro precision and recall aggregate optional selections with null zero denominators", () => {
  const cases = [makeCase("c-1"), makeCase("c-2")];
  const gold = makeGold([
    goldRecord("c-1", [["alpha", "beta"]]),
    goldRecord("c-2", [["gamma"]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      // tp=1 fp=1 fn=1
      makeResult("c-1", "jev", { route: ["alpha", "zeta"] }),
      // tp=1 fp=0 fn=0
      makeResult("c-2", "jev", { route: ["gamma"] }),
    ],
  });
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.equal(aggregates.microPrecision, 2 / 3);
  assert.equal(aggregates.microRecall, 2 / 3);

  const silent = score({
    cases,
    gold,
    jev: [
      makeResult("c-1", "jev", { status: "abstain" }),
      makeResult("c-2", "jev", { status: "abstain" }),
    ],
  });
  const silentAggregates = contestantScore(silent, "jev").aggregates;
  assert.equal(silentAggregates.microPrecision, null);
  assert.equal(silentAggregates.microRecall, 0);

  const allEmpty = score({
    cases: [makeCase("z-1")],
    gold: makeGold([goldRecord("z-1", [[]])]),
    jev: [makeResult("z-1", "jev", { route: [] })],
  });
  const emptyAggregates = contestantScore(allEmpty, "jev").aggregates;
  assert.equal(emptyAggregates.microPrecision, null);
  assert.equal(emptyAggregates.microRecall, null);
});

test("accuracy, status counts, autonomous coverage, and context tokens aggregate correctly", () => {
  const cases = [
    makeCase("c-1"),
    makeCase("c-2", { explicit: ["eta"] }),
    makeCase("c-3"),
    makeCase("c-4"),
  ];
  const gold = makeGold([
    goldRecord("c-1", [["alpha"]]),
    goldRecord("c-2", [["beta"]]),
    goldRecord("c-3", [["gamma"]]),
    goldRecord("c-4", [[]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      // correct: 100 context tokens
      makeResult("c-1", "jev", { route: ["alpha"] }),
      // wrong optional route but forced eta counts: 700 + 300
      makeResult("c-2", "jev", { route: ["eta", "gamma"] }),
      makeResult("c-3", "jev", { status: "abstain" }),
      makeResult("c-4", "jev", { status: "error" }),
    ],
  });
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.equal(contestantScore(board, "jev").denominator, 4);
  assert.equal(aggregates.accuracy, 0.25);
  assert.equal(aggregates.ok, 2);
  assert.equal(aggregates.abstain, 1);
  assert.equal(aggregates.error, 1);
  assert.equal(aggregates.autonomousCoverage, 0.5);
  assert.equal(aggregates.contextTokens, 1100);
});

test("nullable telemetry aggregates use non-null observations and nearest-rank percentiles", () => {
  const cases = [makeCase("c-1"), makeCase("c-2"), makeCase("c-3"), makeCase("c-4")];
  const gold = makeGold([
    goldRecord("c-1", [[]]),
    goldRecord("c-2", [[]]),
    goldRecord("c-3", [[]]),
    goldRecord("c-4", [[]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      makeResult("c-1", "jev", { route: [], inputTokens: 10, latencyMs: 30, costUsd: 0.5 }),
      makeResult("c-2", "jev", { route: [], inputTokens: 30, latencyMs: 10 }),
      makeResult("c-3", "jev", { route: [], inputTokens: 20, latencyMs: 20 }),
      makeResult("c-4", "jev", { route: [] }),
    ],
  });
  const aggregates = contestantScore(board, "jev").aggregates;
  assert.deepEqual(aggregates.inputTokens, { observations: 3, sum: 60, p50: 20, p95: 30 });
  assert.deepEqual(aggregates.latencyMs, { observations: 3, sum: 60, p50: 20, p95: 30 });
  assert.deepEqual(aggregates.costUsd, { observations: 1, sum: 0.5, p50: 0.5, p95: 0.5 });
  assert.equal(aggregates.outputTokens, null);

  const unobserved = score({
    cases,
    gold,
    jev: cases.map((arenaCase) => makeResult(arenaCase.id, "jev", { route: [] })),
  });
  const emptyAggregates = contestantScore(unobserved, "jev").aggregates;
  assert.equal(emptyAggregates.inputTokens, null);
  assert.equal(emptyAggregates.latencyMs, null);
  assert.equal(emptyAggregates.costUsd, null);
});

test("nearest-rank percentiles pick the exact ordered observation", () => {
  const cases = Array.from({ length: 10 }, (_, index) => makeCase(`c-${index}`));
  const gold = makeGold(cases.map((arenaCase) => goldRecord(arenaCase.id, [[]])));
  const board = score({
    cases,
    gold,
    jev: cases.map((arenaCase, index) =>
      makeResult(arenaCase.id, "jev", { route: [], latencyMs: (index + 1) * 10 })
    ),
  });
  const aggregates = contestantScore(board, "jev").aggregates;
  // n=10: p50 index ceil(5)-1=4 -> 50; p95 index ceil(9.5)-1=9 -> 100.
  assert.deepEqual(aggregates.latencyMs, { observations: 10, sum: 550, p50: 50, p95: 100 });
});

test("jev-with-codex-fallback replaces only jev abstains whose codex result is ok", () => {
  const cases = [
    makeCase("c-1", { required: ["theta"] }),
    makeCase("c-2", { required: ["theta"], risk: "high" }),
    makeCase("c-3", { required: ["theta"] }),
    makeCase("c-4", { required: ["theta"] }),
  ];
  const gold = makeGold([
    goldRecord("c-1", [["alpha"]], { mandatory: ["theta"] }),
    goldRecord("c-2", [["beta"]], { mandatory: ["theta"] }),
    goldRecord("c-3", [["gamma"]], { mandatory: ["theta"] }),
    goldRecord("c-4", [["delta"]], { mandatory: ["theta"] }),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      makeResult("c-1", "jev", { status: "abstain", reason: "low-confidence" }),
      makeResult("c-2", "jev", { status: "abstain", reason: "low-confidence" }),
      makeResult("c-3", "jev", { status: "error", reason: "adapter-failure" }),
      makeResult("c-4", "jev", { route: ["theta", "delta"] }),
    ],
    codex: [
      // Replaces the jev abstain: correct and no mandatory miss.
      makeResult("c-1", "codex", { route: ["theta", "alpha"] }),
      // Codex abstain cannot replace: jev abstain stands.
      makeResult("c-2", "codex", { status: "abstain", reason: "uncertain" }),
      // Codex ok does not replace a jev error.
      makeResult("c-3", "codex", { route: ["theta", "gamma"] }),
      // Jev already ok: no replacement.
      makeResult("c-4", "codex", { status: "error", reason: "missing-record" }),
    ],
  });
  const fallback = board.jevWithCodexFallback;
  assert.equal(fallback.replacedCases, 1);
  // Correct: c-1 via codex route + c-4 via jev route = 2/4.
  assert.equal(fallback.accuracy, 0.5);
  // Mandatory misses: c-2 abstain misses theta (high risk), c-3 error misses theta.
  assert.equal(fallback.mandatoryMisses, 2);
  assert.equal(fallback.highRiskMandatoryMisses, 1);
  const jevAggregates = contestantScore(board, "jev").aggregates;
  assert.equal(jevAggregates.accuracy, 0.25);
  assert.equal(jevAggregates.mandatoryMisses, 3);
});

test("contestant order is fixed and case records sort by case ID", () => {
  const cases = [makeCase("c-2"), makeCase("c-1"), makeCase("c-3")];
  const gold = makeGold([
    goldRecord("c-3", [[]]),
    goldRecord("c-1", [[]]),
    goldRecord("c-2", [[]]),
  ]);
  const board = score({
    cases,
    gold,
    jev: [
      makeResult("c-3", "jev", { route: [] }),
      makeResult("c-1", "jev", { route: [] }),
      makeResult("c-2", "jev", { route: [] }),
    ],
  });
  assert.deepEqual(
    board.contestants.map((entry) => entry.contestantId),
    ["jev", "codex", "rules"],
  );
  for (const entry of board.contestants) {
    assert.deepEqual(
      entry.cases.map((item) => item.caseId),
      ["c-1", "c-2", "c-3"],
    );
    assert.equal(entry.denominator, 3);
  }
  assert.equal(board.schemaVersion, 1);
  assert.equal(board.scope, "development");
});

test("scoreArena rejects mismatched run records", () => {
  const cases = [makeCase("c-1")];
  const gold = makeGold([goldRecord("c-1", [[]])]);
  const jev = [makeResult("c-1", "jev", { route: [] })];
  assert.throws(() =>
    scoreArena({
      manifest: MANIFEST,
      cases,
      gold,
      runs: {
        jev,
        codex: [],
        rules: fillerRuns("rules", cases),
      },
    }), { message: "invalid-arena-runs" });
  assert.throws(() =>
    scoreArena({
      manifest: MANIFEST,
      cases,
      gold,
      runs: {
        jev: [makeResult("c-1", "codex", { route: [] })],
        codex: fillerRuns("codex", cases),
        rules: fillerRuns("rules", cases),
      },
    }), { message: "invalid-arena-runs" });
  assert.throws(() =>
    scoreArena({
      manifest: MANIFEST,
      cases,
      gold,
      runs: {
        jev: [makeResult("c-1", "jev", { route: [] }), makeResult("c-1", "jev", { route: [] })],
        codex: fillerRuns("codex", cases),
        rules: fillerRuns("rules", cases),
      },
    }), { message: "invalid-arena-runs" });
  assert.throws(() =>
    scoreArena({
      manifest: MANIFEST,
      cases,
      gold: makeGold([]),
      runs: {
        jev,
        codex: fillerRuns("codex", cases),
        rules: fillerRuns("rules", cases),
      },
    }), { message: "invalid-arena-gold" });
});
