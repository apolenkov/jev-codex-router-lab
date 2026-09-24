import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Fetch } from "@typesafe-ai/sdk";
import {
  CalibrationError,
  parseCalibrationCorpus,
  type CalibrationCheckpoint,
  type CalibrationCorpus,
} from "./calibration-runner.js";
import {
  collectPass1Evidence,
  createPass1CollectionTransport,
  createPass1EvidenceSink,
  PASS1_CORPUS_FILE_SHA256,
  PASS1_QUESTION_BUILDER_SHA256,
  type Pass1CollectionResult,
} from "./pass1-calibration-collector.js";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE_SUBDIRECTORY = "pass1-calibration";
const CORPUS_PATH = "fixtures/calibration-corpus.json";
const QUESTION_BUILDER_PATH = "src/questions.ts";

export interface Pass1CalibrationCliOptions {
  readonly repositoryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: Fetch;
  readonly createTransport?: typeof createPass1CollectionTransport;
}

export interface Pass1CalibrationCliSummary {
  readonly status: "complete" | "terminal";
  readonly collectedCases: number;
  readonly failedCase: string | null;
  readonly failure: string | null;
  readonly attempts: number;
  readonly spentUsd: number;
}

export interface Pass1CalibrationCliResult {
  readonly exitCode: 0 | 2;
  readonly summary?: Pass1CalibrationCliSummary;
  readonly error?: string;
}

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
};

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

interface PinnedFile {
  readonly contents: string;
  readonly sha256: string;
}

const readPinnedFile = async (
  root: string,
  relativePath: string,
): Promise<PinnedFile | null> => {
  const path = join(root, relativePath);
  try {
    if (await realpath(path) !== path || !(await lstat(path)).isFile()) {
      return null;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return null;
      const buffer = await handle.readFile();
      const current = await lstat(path);
      if (!current.isFile() || !sameIdentity(opened, current)) {
        return null;
      }
      return {
        contents: buffer.toString("utf8"),
        sha256: createHash("sha256").update(buffer).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

interface EvidenceDirectory {
  readonly handle: FileHandle;
  readonly requestedDirectory: string;
  readonly identity: Stats;
  readonly directory: string;
}

const pass1EvidenceDirectory = async (
  repositoryRoot: string,
): Promise<EvidenceDirectory | null> => {
  let handle: FileHandle | undefined;
  try {
    const root = await realpath(repositoryRoot);
    const artifacts = join(root, "artifacts");
    const artifactsStat = await lstat(artifacts);
    if (!artifactsStat.isDirectory()) return null;
    const canonicalArtifacts = await realpath(artifacts);
    if (!isWithin(root, canonicalArtifacts)) return null;

    const directory = join(canonicalArtifacts, EVIDENCE_SUBDIRECTORY);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) return null;
    }
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return null;
    }
    const canonicalDirectory = await realpath(directory);
    if (canonicalDirectory !== directory || !isWithin(root, canonicalDirectory)) {
      return null;
    }

    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = await handle.stat();
    if (!identity.isDirectory() || !sameIdentity(identity, directoryStat)) {
      return null;
    }

    const result = {
      handle,
      requestedDirectory: directory,
      identity,
      directory: canonicalDirectory,
    };
    handle = undefined;
    return result;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const evidenceDirectoryUnchanged = async (
  directory: EvidenceDirectory,
): Promise<boolean> => {
  try {
    const current = await lstat(directory.requestedDirectory);
    return (
      current.isDirectory() &&
      sameIdentity(directory.identity, current) &&
      await realpath(directory.requestedDirectory) === directory.directory
    );
  } catch {
    return false;
  }
};

const summaryOf = (
  result: Pass1CollectionResult,
): Pass1CalibrationCliSummary => ({
  status: result.status,
  collectedCases:
    result.records.filter((record) => record.outcome === "collected").length,
  failedCase: result.failure?.caseId ?? null,
  failure: result.failure?.error ?? null,
  attempts: result.accounting.attempts,
  spentUsd: result.accounting.spentUsd,
});

export const createPass1CheckpointStore = (
  path: string,
  guard: () => Promise<void>,
) => {
  let file: FileHandle | null = null;
  const write = async (checkpoint: CalibrationCheckpoint): Promise<void> => {
    if (file === null) throw new CalibrationError("checkpoint-not-claimed");
    await guard();
    const bytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten === 0) throw new CalibrationError("checkpoint-write");
      offset += bytesWritten;
    }
    await file.truncate(bytes.length);
    await file.sync();
    await guard();
  };
  return {
    claim: async (checkpoint: CalibrationCheckpoint): Promise<boolean> => {
      await guard();
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) return false;
        throw error;
      }
      await write(checkpoint);
      return true;
    },
    write,
    close: async (): Promise<void> => {
      await file?.close();
      file = null;
    },
  };
};

export const runPass1CalibrationCli = async (
  argv: readonly string[],
  options: Pass1CalibrationCliOptions = {},
): Promise<Pass1CalibrationCliResult> => {
  if (argv.length !== 0) {
    return { exitCode: 2, error: "invalid CLI usage" };
  }
  const env = options.env ?? process.env;
  const apiKey = env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return { exitCode: 2, error: "missing TYPESAFE_API_KEY" };
  }

  let repositoryRoot: string;
  let checkpoint: ReturnType<typeof createPass1CheckpointStore> | null = null;
  try {
    repositoryRoot = await realpath(
      resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT),
    );
  } catch {
    return { exitCode: 2, error: "evidence path unavailable" };
  }
  const directory = await pass1EvidenceDirectory(repositoryRoot);
  if (directory === null) {
    return { exitCode: 2, error: "evidence path unavailable" };
  }

  try {
    const corpusFile = await readPinnedFile(repositoryRoot, CORPUS_PATH);
    const questionsFile = await readPinnedFile(
      repositoryRoot,
      QUESTION_BUILDER_PATH,
    );
    if (corpusFile === null || questionsFile === null) {
      return { exitCode: 2, error: "invalid frozen input" };
    }
    if (
      corpusFile.sha256 !== PASS1_CORPUS_FILE_SHA256 ||
      questionsFile.sha256 !== PASS1_QUESTION_BUILDER_SHA256
    ) {
      return { exitCode: 2, error: "frozen input fingerprint mismatch" };
    }
    let corpus: CalibrationCorpus;
    try {
      corpus = parseCalibrationCorpus(corpusFile.contents);
    } catch {
      return { exitCode: 2, error: "invalid frozen input" };
    }

    const assertEvidencePath = async (): Promise<void> => {
      if (!await evidenceDirectoryUnchanged(directory)) {
        throw new CalibrationError("evidence-write");
      }
    };
    checkpoint = createPass1CheckpointStore(
      join(directory.directory, "checkpoint.json"),
      assertEvidencePath,
    );
    const transport = await (options.createTransport ??
      createPass1CollectionTransport)({
      apiKey,
      corpus,
      fetch: options.fetch ?? globalThis.fetch,
      checkpoint,
    });
    if (!await evidenceDirectoryUnchanged(directory)) {
      await transport.terminalize("post-transport-validation");
      return { exitCode: 2, error: "evidence path unavailable" };
    }
    const result = await collectPass1Evidence({
      corpus,
      corpusFileSha256: corpusFile.sha256,
      questionBuilderSha256: questionsFile.sha256,
      transport,
      sink: createPass1EvidenceSink(directory.directory, assertEvidencePath),
    });
    if (!await evidenceDirectoryUnchanged(directory)) {
      return { exitCode: 2, error: "evidence path unavailable" };
    }
    return {
      exitCode: result.status === "complete" ? 0 : 2,
      summary: summaryOf(result),
    };
  } catch {
    return { exitCode: 2, error: "collection failed" };
  } finally {
    await checkpoint?.close().catch(() => undefined);
    await directory.handle.close().catch(() => undefined);
  }
};

const main = async (): Promise<void> => {
  const result = await runPass1CalibrationCli(process.argv.slice(2));
  if (result.summary !== undefined) {
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
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
