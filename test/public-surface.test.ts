import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("package metadata describes the private Apache-2.0 public project", () => {
  const packageJson = readJson("package.json");

  assert.equal(packageJson.name, "jev-codex-router-lab");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "Apache-2.0");
  assert.equal(packageJson.description, "Experimental TypeScript lab for deterministic, two-pass Jev skill routing.");
  assert.deepEqual(packageJson.keywords, ["jev", "routing", "skills", "typesafe-ai", "typescript"]);
  assert.deepEqual(packageJson.engines, { node: ">=20.19.0" });
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/apolenkov/jev-codex-router-lab.git",
  });
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/apolenkov/jev-codex-router-lab/issues",
  });
  assert.equal(packageJson.homepage, "https://github.com/apolenkov/jev-codex-router-lab#readme");
  assert.equal(Object.hasOwn(packageJson, "exports"), false);
  assert.equal(Object.hasOwn(packageJson, "bin"), false);
});

test("every installed dependency has a reviewed compatible SPDX license", () => {
  const lock = readJson("package-lock.json");
  const packages = lock.packages as Record<string, { license?: unknown }>;
  const approved = new Set([
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MIT",
  ]);
  const rejected = Object.entries(packages)
    .filter(([path]) => path.startsWith("node_modules/"))
    .filter(([, metadata]) => typeof metadata.license !== "string" || !approved.has(metadata.license))
    .map(([path, metadata]) => `${path}: ${String(metadata.license)}`);

  assert.deepEqual(rejected, []);
});

test("tracked and packed surfaces exclude local-only files", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const forbiddenTreePrefixes = [".agents/", ".devin/", ".superpowers/", "dist/", "node_modules/"];
  const forbiddenTree = tracked.filter((path) =>
    path === ".env" ||
    path.startsWith(".env.") ||
    path.endsWith("/.DS_Store") ||
    forbiddenTreePrefixes.some((prefix) => path.startsWith(prefix))
  );
  assert.deepEqual(forbiddenTree, []);

  const report = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
  const pack = Array.isArray(report) ? report : Object.values(report);
  const packed = pack[0]?.files.map(({ path }) => path) ?? [];
  const allowedFiles = new Set(["CHANGELOG.md", "LICENSE", "README.md", "package.json"]);
  const allowedPrefixes = ["docs/", "examples/", "fixtures/arena/", "src/"];
  const forbiddenPackage = packed.filter((path) =>
    !allowedFiles.has(path) && !allowedPrefixes.some((prefix) => path.startsWith(prefix))
  );

  assert.ok(packed.includes("package.json"));
  assert.deepEqual(forbiddenPackage, []);
});

test("public text excludes machine paths and internal task or session ids", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const localRoot = ["", "Users", "wrk"].join("/");
  const allowedSentinels = [`${localRoot}/private`, `${localRoot}/protected`];
  const findings: string[] = [];

  for (const path of tracked) {
    const buffer = readFileSync(path);
    if (buffer.includes(0)) {
      continue;
    }
    let text = buffer.toString("utf8");
    for (const sentinel of allowedSentinels) {
      text = text.replaceAll(sentinel, "synthetic-redaction-sentinel");
    }
    if (
      text.includes(localRoot) ||
      /\bTASK-\d+(?:\.\d+)?\b/.test(text) ||
      /\b01[a-f\d]{6,}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\b/i.test(text)
    ) {
      findings.push(path);
    }
  }

  assert.deepEqual(findings, []);
});

test("offline fake-gateway example needs no credential or network", () => {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.includes("TYPESAFE") || name.includes("VERCEL") || name.includes("AI_GATEWAY")) {
      delete environment[name];
    }
  }
  const denyNetwork = encodeURIComponent(`
    import http from "node:http";
    import https from "node:https";
    import net from "node:net";
    import tls from "node:tls";
    import { syncBuiltinESMExports } from "node:module";
    const deny = () => { throw new Error("offline example attempted network access"); };
    http.request = deny;
    http.get = deny;
    https.request = deny;
    https.get = deny;
    net.connect = deny;
    net.createConnection = deny;
    tls.connect = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
  `);
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      `data:text/javascript,${denyNetwork}`,
      "dist/src/offline-example.js",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: environment },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout) as unknown, {
    example: "offline-fake-gateway",
    fake: true,
    decision: {
      status: "fallback",
      reason: "service-error",
      forcedSkillIds: ["systematic-debugging"],
      protectedContextIds: ["synthetic-protected-context"],
    },
  });
  assert.equal(result.stdout.includes("SYNTHETIC-PRIVATE-BODY"), false);
});

test("arena surface ships the development command, docs, and frozen fixtures", () => {
  const packageJson = readJson("package.json") as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["arena:dev"], "npm run build --silent && node dist/src/arena-cli.js");

  const readme = readFileSync("README.md", "utf8");
  const arenaSection = readme
    .slice(readme.indexOf("## Development arena"))
    .replace(/\s+/g, " ");
  for (const label of [
    "development-only",
    "offline",
    "fixture-replay",
    "not evidence for model superiority or production readiness",
  ]) {
    assert.ok(arenaSection.includes(label), `README arena section must declare ${label}`);
  }

  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => path.length > 0);
  const report = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf8",
    }),
  ) as { files: { path: string }[] }[] | Record<string, { files: { path: string }[] }>;
  const pack = Array.isArray(report) ? report : Object.values(report);
  const packed = pack[0]?.files.map(({ path }) => path) ?? [];
  for (const path of [
    "docs/arena-development.md",
    "fixtures/arena/dev-cases.json",
    "fixtures/arena/dev-gold.json",
    "fixtures/arena/skill-manifest.json",
    "fixtures/arena/rules.json",
    "fixtures/arena/jev-replay.json",
    "fixtures/arena/codex-replay.json",
    "fixtures/arena/fingerprints.json",
    "fixtures/arena/rubric-v1.md",
  ]) {
    assert.ok(tracked.includes(path), `${path} must be tracked`);
    assert.ok(packed.includes(path), `${path} must be packed`);
  }
});
