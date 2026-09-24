import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CALIBRATION_MODEL,
  CalibrationError,
  type CalibrationCheckpoint,
  type CalibrationCheckpointStore,
} from "../src/calibration-runner.js";
import {
  buildPass1ThresholdEvaluation,
  runPass1ThresholdEvaluation,
  PASS1_EVALUATION_REPORT_KIND,
  type Pass1ThresholdEvaluationReport,
} from "../src/pass1-threshold-evaluator.js";
import {
  createPass1ThresholdTransport,
  parsePass1AnnotatedCorpus,
  parsePass1CorpusManifest,
  runPass1ThresholdCollection,
  PASS1_THRESHOLD_LIMITS,
  type Pass1AnnotatedCorpus,
  type Pass1ThresholdCaseRecord,
  type Pass1ThresholdEvidenceManifest,
  type Pass1ThresholdEvidenceSink,
  type Pass1ThresholdEvidenceSummary,
} from "../src/pass1-threshold-runner.js";
import {
  buildPass1SelectionArtifact,
  parsePass1SelectionArtifact,
  selectPass1Threshold,
  scorePass1ThresholdCases,
  type Pass1ThresholdSelectionArtifact,
} from "../src/pass1-threshold-selector.js";

const CALIBRATION_CORPUS_PATH = "fixtures/pass1-calibration-cases.json";
const EVALUATION_CORPUS_PATH = "fixtures/pass1-evaluation-cases.json";
const CORPUS_MANIFEST_PATH = "fixtures/pass1-corpus-manifest.json";
const QUESTION_BUILDER_PATH = "src/questions.ts";

const fileSha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

interface SynthesizedQuestion {
  readonly type: string;
  readonly criteria?: Record<string, unknown>;
}

const synthesizeAnswers = (
  questions: Readonly<Record<string, unknown>>,
  options: { readonly confidence?: number; readonly noul?: number } = {},
): Record<string, unknown> => {
  const confidence = options.confidence ?? 0.9;
  const noul = options.noul ?? 0.2;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const typed = question as SynthesizedQuestion;
    if (typed.type === "noul") {
      answers[id] = { type: "noul", noul };
      continue;
    }
    const candidates = Object.keys(typed.criteria ?? {});
    const selected = candidates[0]!;
    answers[id] = {
      type: "choice",
      choice: selected,
      confidence,
      probabilities: Object.fromEntries(
        candidates.map((candidate, index) => [
          candidate,
          index === 0 ? 0.9 : 0.1 / Math.max(1, candidates.length - 1),
        ]),
      ),
    };
  }
  return answers;
};

const envelope = (
  answers: Record<string, unknown>,
  inputTokens = 100,
): Record<string, unknown> => ({
  model: CALIBRATION_MODEL,
  usage: { input_tokens: inputTokens, output_tokens: 10 },
  answers,
});

const fakePass1Fetch = (
  overrides: {
    readonly confidence?: number;
    readonly noul?: number;
    readonly respond?: (caseId: string) => Response | undefined;
    readonly requests?: string[];
  } = {},
): Fetch => async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as {
    state: { echo: { taskId: string } };
    questions: Record<string, unknown>;
  };
  const caseId = body.state.echo.taskId;
  overrides.requests?.push(caseId);
  const injected = overrides.respond?.(caseId);
  if (injected !== undefined) {
    return injected;
  }
  const answers = synthesizeAnswers(body.questions, {
    ...(overrides.confidence === undefined
      ? {}
      : { confidence: overrides.confidence }),
    ...(overrides.noul === undefined ? {} : { noul: overrides.noul }),
  });
  return new Response(JSON.stringify(envelope(answers)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const memoryCheckpointStore = (): {
  readonly store: CalibrationCheckpointStore;
  readonly snapshots: CalibrationCheckpoint[];
} => {
  let current: CalibrationCheckpoint | null = null;
  const snapshots: CalibrationCheckpoint[] = [];
  return {
    snapshots,
    store: {
      claim: async (checkpoint) => {
        if (current !== null) return false;
        current = structuredClone(checkpoint);
        snapshots.push(structuredClone(checkpoint));
        return true;
      },
      write: async (checkpoint) => {
        current = structuredClone(checkpoint);
        snapshots.push(structuredClone(checkpoint));
      },
    },
  };
};

const memorySink = (): {
  readonly sink: Pass1ThresholdEvidenceSink;
  readonly manifest: { value: Pass1ThresholdEvidenceManifest | null };
  readonly cases: Map<string, Pass1ThresholdCaseRecord>;
  readonly summary: { value: Pass1ThresholdEvidenceSummary | null };
} => {
  const manifest: { value: Pass1ThresholdEvidenceManifest | null } = {
    value: null,
  };
  const cases = new Map<string, Pass1ThresholdCaseRecord>();
  const summary: { value: Pass1ThresholdEvidenceSummary | null } = {
    value: null,
  };
  return {
    manifest,
    cases,
    summary,
    sink: {
      writeManifest: async (value) => {
        if (manifest.value !== null) {
          throw new CalibrationError("evidence-exists");
        }
        manifest.value = structuredClone(value);
      },
      writeCaseRecord: async (caseId, record) => {
        cases.set(caseId, structuredClone(record));
      },
      writeSummary: async (value) => {
        summary.value = structuredClone(value);
      },
    },
  };
};

const calibrationReason = (reason: string) => (error: unknown): boolean =>
  error instanceof Error &&
  error.name === "CalibrationError" &&
  (error as CalibrationError).reason === reason;

const loadCorpus = (
  split: "calibration" | "evaluation",
): Pass1AnnotatedCorpus =>
  parsePass1AnnotatedCorpus(
    readFileSync(
      split === "calibration" ? CALIBRATION_CORPUS_PATH : EVALUATION_CORPUS_PATH,
      "utf8",
    ),
    split,
  );

const loadPins = (split: "calibration" | "evaluation") => {
  const manifest = parsePass1CorpusManifest(
    readFileSync(CORPUS_MANIFEST_PATH, "utf8"),
  );
  return {
    corpusFileSha256: manifest.splits[split].sha256,
    questionBuilderSha256: manifest.questionBuilder.sha256,
  };
};

const buildArtifact = (
  corpus: Pass1AnnotatedCorpus,
  records: readonly Pass1ThresholdCaseRecord[],
  overrides: Partial<Pass1ThresholdSelectionArtifact> = {},
): { artifact: Pass1ThresholdSelectionArtifact; sha256: string } => {
  const selection = selectPass1Threshold(corpus, records);
  const artifact = {
    ...buildPass1SelectionArtifact(selection, {
      corpusFileSha256: "a".repeat(64),
      evaluationCorpusFileSha256: "b".repeat(64),
      questionBuilderSha256: "c".repeat(64),
      corpusFingerprint: "d".repeat(64),
      evidenceSha256: "e".repeat(64),
    }),
    ...overrides,
  };
  return {
    artifact,
    sha256: createHash("sha256")
      .update(JSON.stringify(artifact))
      .digest("hex"),
  };
};

const evaluate = async (
  corpus: Pass1AnnotatedCorpus,
  artifact: Pass1ThresholdSelectionArtifact,
  artifactSha256: string,
  fetch: Fetch,
): Promise<{
  report: Pass1ThresholdEvaluationReport;
  written: Pass1ThresholdEvaluationReport[];
  requests: string[];
  sink: ReturnType<typeof memorySink>;
}> => {
  const sink = memorySink();
  const written: Pass1ThresholdEvaluationReport[] = [];
  const requests: string[] = [];
  const wrappedFetch: Fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { echo: { taskId: string } };
    };
    requests.push(body.state.echo.taskId);
    return fetch(input, init);
  };
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch: wrappedFetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.evaluation,
  });
  const pins = loadPins("evaluation");
  const { report } = await runPass1ThresholdEvaluation({
    artifact,
    artifactSha256,
    corpus,
    corpusPath: EVALUATION_CORPUS_PATH,
    pins,
    actual: {
      corpusFileSha256: fileSha256(EVALUATION_CORPUS_PATH),
      questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
    },
    transport,
    sink: sink.sink,
    writeReport: async (report) => {
      written.push(structuredClone(report));
    },
  });
  return { report, written, requests, sink };
};

test("evaluation runs the frozen tuple once over all 28 cases in order", async () => {
  const corpus = loadCorpus("evaluation");
  const calibrationRecords: Pass1ThresholdCaseRecord[] = [];
  const { artifact, sha256 } = buildArtifact(
    loadCorpus("calibration"),
    calibrationRecords,
  );
  const fetch = fakePass1Fetch({ confidence: 1, noul: 0.2 });

  const { report, written, requests, sink } = await evaluate(
    corpus,
    artifact,
    sha256,
    fetch,
  );

  assert.deepEqual(requests, corpus.cases.map(({ caseId }) => caseId));
  assert.equal(requests.length, 28);
  assert.equal(written.length, 1);
  assert.equal(report.kind, PASS1_EVALUATION_REPORT_KIND);
  assert.equal(report.split, "evaluation");
  assert.equal(report.status, "complete");
  assert.equal(report.totalCases, 28);
  assert.equal(report.accounting.attempts, 28);
  assert.deepEqual(
    {
      floor: report.selection.floor,
      lo: report.selection.lo,
      hi: report.selection.hi,
    },
    artifact.selected,
  );
  assert.equal(report.selection.artifactSha256, sha256);
  assert.equal(sink.manifest.value?.split, "evaluation");
  assert.equal(sink.manifest.value?.limits.maxAttempts, 28);
});

test("the report scores exactly what the frozen comparison produces", async () => {
  const corpus = loadCorpus("evaluation");
  const { artifact, sha256 } = buildArtifact(loadCorpus("calibration"), []);
  const fetch = fakePass1Fetch({ confidence: 1, noul: 0.2 });

  const { report } = await evaluate(corpus, artifact, sha256, fetch);

  const expected = scorePass1ThresholdCases(
    corpus,
    (await collectRecords(corpus, fetch)).records,
    artifact.selected,
  );
  assert.equal(report.accepted, expected.accepted);
  assert.equal(report.rejected, expected.rejected);
  assert.equal(report.totalErrors, expected.totalErrors);
  assert.deepEqual(report.perSignal, expected.perSignal);
});

const collectRecords = (corpus: Pass1AnnotatedCorpus, fetch: Fetch) => {
  const sink = memorySink();
  return createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.evaluation,
  }).then((transport) =>
    runPass1ThresholdCollection({
      split: "evaluation",
      corpus,
      corpusPath: EVALUATION_CORPUS_PATH,
      pins: loadPins("evaluation"),
      actual: {
        corpusFileSha256: fileSha256(EVALUATION_CORPUS_PATH),
        questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
      },
      transport,
      sink: sink.sink,
    })
  );
};

test("evaluation uses the artifact tuple verbatim and never retunes", async () => {
  const corpus = loadCorpus("evaluation");
  const fetch = fakePass1Fetch({ confidence: 1, noul: 0.2 });
  // A tuple that selection would never pick for this corpus on its own;
  // the evaluator must still report it verbatim.
  const frozen = { floor: 0.8, lo: 0.44, hi: 0.56 };
  const { artifact, sha256 } = buildArtifact(loadCorpus("calibration"), [], {
    selected: frozen,
  });

  const { report, sink } = await evaluate(corpus, artifact, sha256, fetch);

  assert.deepEqual(
    {
      floor: report.selection.floor,
      lo: report.selection.lo,
      hi: report.selection.hi,
    },
    frozen,
  );
  const rescored = scorePass1ThresholdCases(
    corpus,
    [...sink.cases.values()],
    frozen,
  );
  assert.equal(report.accepted, rescored.accepted);
  assert.equal(report.totalErrors, rescored.totalErrors);
});

test("evaluation refuses a selection tuple outside the frozen grid", async () => {
  const corpus = loadCorpus("evaluation");
  const { artifact, sha256 } = buildArtifact(loadCorpus("calibration"), [], {
    selected: { floor: 0.51, lo: 0.4, hi: 0.6 },
  });
  let calls = 0;
  const fetch: Fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.evaluation,
  });
  const sink = memorySink();

  await assert.rejects(
    runPass1ThresholdEvaluation({
      artifact,
      artifactSha256: sha256,
      corpus,
      corpusPath: EVALUATION_CORPUS_PATH,
      pins: loadPins("evaluation"),
      actual: {
        corpusFileSha256: fileSha256(EVALUATION_CORPUS_PATH),
        questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
      },
      transport,
      sink: sink.sink,
      writeReport: async () => {},
    }),
    calibrationReason("invalid-selection-artifact"),
  );
  assert.equal(calls, 0);
  assert.equal(sink.manifest.value, null);
  assert.throws(
    () =>
      buildPass1ThresholdEvaluation({
        artifact,
        artifactSha256: sha256,
        corpus,
        records: [],
        status: "complete",
        accounting: { attempts: 0, spentUsd: 0, reservedUsd: 0, terminal: false },
        pins: loadPins("evaluation"),
      }),
    calibrationReason("invalid-selection-artifact"),
  );
});

test("an aborted evaluation preserves partial evidence and stays incomplete", async () => {
  const corpus = loadCorpus("evaluation");
  const { artifact, sha256 } = buildArtifact(loadCorpus("calibration"), []);
  const fetch = fakePass1Fetch({
    respond: (caseId) =>
      caseId === "EVAL-004" ? new Response("{}", { status: 500 }) : undefined,
  });

  const { report, sink } = await evaluate(corpus, artifact, sha256, fetch);

  assert.equal(report.status, "incomplete");
  assert.equal(report.accepted + report.rejected, report.totalCases);
  assert.ok(report.uncollected > 0);
  assert.equal(sink.summary.value?.incomplete, true);
  assert.equal(sink.cases.size, 4);
});

test("the report pins the corpus files, question builder, and artifact hash", async () => {
  const corpus = loadCorpus("evaluation");
  const { artifact, sha256 } = buildArtifact(loadCorpus("calibration"), []);
  const fetch = fakePass1Fetch();
  const pins = loadPins("evaluation");

  const { report } = await evaluate(corpus, artifact, sha256, fetch);

  assert.equal(report.inputs.corpusFileSha256, pins.corpusFileSha256);
  assert.equal(
    report.inputs.questionBuilderSha256,
    pins.questionBuilderSha256,
  );
  assert.equal(report.inputs.corpusFingerprint.length, 64);
  assert.equal(report.selection.artifactSha256, sha256);
  assert.equal(report.selection.eligible, artifact.eligible);
  assert.equal(report.selection.tieBroken, artifact.tieBroken);
});

test("selection artifacts from the runner parse path feed the evaluator", async () => {
  const calibrationCorpus = loadCorpus("calibration");
  const fetch = fakePass1Fetch({ confidence: 1, noul: 0.2 });
  const sink = memorySink();
  const transport = await createPass1ThresholdTransport({
    apiKey: "test-key",
    corpus: calibrationCorpus,
    fetch,
    checkpoint: memoryCheckpointStore().store,
    limits: PASS1_THRESHOLD_LIMITS.calibration,
  });
  const result = await runPass1ThresholdCollection({
    split: "calibration",
    corpus: calibrationCorpus,
    corpusPath: CALIBRATION_CORPUS_PATH,
    pins: loadPins("calibration"),
    actual: {
      corpusFileSha256: fileSha256(CALIBRATION_CORPUS_PATH),
      questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
    },
    transport,
    sink: sink.sink,
  });
  const selection = selectPass1Threshold(calibrationCorpus, result.records);
  const artifact = buildPass1SelectionArtifact(selection, {
    corpusFileSha256: fileSha256(CALIBRATION_CORPUS_PATH),
    evaluationCorpusFileSha256: fileSha256(EVALUATION_CORPUS_PATH),
    questionBuilderSha256: fileSha256(QUESTION_BUILDER_PATH),
    corpusFingerprint: "d".repeat(64),
    evidenceSha256: "e".repeat(64),
  });
  const parsed = parsePass1SelectionArtifact(JSON.stringify(artifact));

  const evaluationCorpus = loadCorpus("evaluation");
  const { report } = await evaluate(
    evaluationCorpus,
    parsed,
    createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
    fakePass1Fetch({ confidence: 1, noul: 0.2 }),
  );

  assert.equal(report.status, "complete");
  assert.deepEqual(
    {
      floor: report.selection.floor,
      lo: report.selection.lo,
      hi: report.selection.hi,
    },
    parsed.selected,
  );
});
