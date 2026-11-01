import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end: run the real CLI (through tsx) with answers piped to stdin.
const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "src", "cli.ts");
const TIMEOUT = 30_000;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input = ""): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.on("error", () => {}); // the CLI may exit before reading stdin
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("cli", () => {
  let root: string;
  let nodeModules: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "diskbroom-cli-"));
    const files: Record<string, string> = {
      "web/package.json": "{}",
      "web/node_modules/dep/index.js": "x".repeat(4000),
      "rs/Cargo.toml": "[package]",
      "rs/target/debug/app": "y".repeat(2000),
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    nodeModules = join(root, "web", "node_modules");
    target = join(root, "rs", "target");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("only reports by default", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("nothing was deleted");
    expect(run.stdout).not.toMatch(/Select folders/);
    expect(await exists(nodeModules)).toBe(true);
  });

  it("rejects --delete without --interactive", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, "--delete"], "all\nyes\n");

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--interactive");
    expect(await exists(nodeModules)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it("rejects --interactive together with --json", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, "-i", "--json"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--json");
  });

  it("-i is a dry run", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, "-i"], "all\n");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Dry run — nothing was deleted");
    expect(await exists(nodeModules)).toBe(true);
    expect(await exists(target)).toBe(true);
  });

  it("-i --delete cancels when stdin ends without an answer", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, "-i", "--delete"], "");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Nothing was deleted");
    expect(await exists(nodeModules)).toBe(true);
  });

  it("-i --delete removes the picked folder once confirmed", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, "-i", "--delete"], "1\nyes\n");

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/✓ removed\s+web.node_modules/);
    expect(await exists(nodeModules)).toBe(false);
    expect(await exists(join(root, "web", "package.json"))).toBe(true);
    expect(await exists(target)).toBe(true); // not picked
  });

  it("scans every path given", { timeout: TIMEOUT }, async () => {
    const run = await runCli([join(root, "web"), join(root, "rs"), "--json"]);
    const report = JSON.parse(run.stdout) as { root: string; roots: string[]; findings: Array<{ path: string }> };

    expect(run.code).toBe(0);
    expect(report.roots).toEqual([join(root, "web"), join(root, "rs")]);
    expect(report.root).toBe(join(root, "web")); // kept for existing scripts
    expect(report.findings.map((f) => f.path).sort()).toEqual([nodeModules, target].sort());
  });

  it("lists each folder once when paths overlap or repeat", { timeout: TIMEOUT }, async () => {
    const run = await runCli([root, join(root, "web"), root, "--json"]);
    const report = JSON.parse(run.stdout) as { roots: string[]; findings: Array<{ path: string }> };

    expect(report.roots).toEqual([root, join(root, "web")]);
    expect(report.findings.filter((f) => f.path === nodeModules)).toHaveLength(1);
  });

  it("rejects a missing path before scanning anything", { timeout: TIMEOUT }, async () => {
    const missing = join(root, "nope");
    const run = await runCli([root, missing, "--json"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`path does not exist: ${missing}`);
    expect(run.stdout).toBe("");
  });

  it("-i --delete works across several paths", { timeout: TIMEOUT }, async () => {
    const run = await runCli([join(root, "web"), join(root, "rs"), "-i", "--delete"], "all\nyes\n");

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/✓ removed\s+web.node_modules/); // relative to the shared parent
    expect(await exists(nodeModules)).toBe(false);
    expect(await exists(target)).toBe(false);
  });
});

// Permission bits do not deny access on Windows or when running as root.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable paths in CLI output", () => {
  let root: string;
  let blocked: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "diskbroom-cli-"));
    blocked = join(root, "blocked");
    await mkdir(blocked);
    await chmod(blocked, 0);
  });
  afterAll(async () => {
    await chmod(blocked, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

  it("warns even when no artifacts were found and lists details only with --verbose", () => {
    const normal = run();
    expect(normal).toContain("1 path could not be read; totals may be incomplete.");
    expect(normal).toContain("Use --verbose");
    expect(normal).not.toContain("blocked (EACCES)");
    expect(run("--verbose")).toContain("blocked (EACCES)");
  });

  it("includes error counts and paths without contaminating JSON output", () => {
    const result = JSON.parse(run("--json"));
    expect(result.errorCount).toBe(1);
    expect(result.errors).toEqual([{ path: blocked, code: "EACCES" }]);
    expect(result.findings).toEqual([]);
  });

  it("reports readable findings alongside the warning", async () => {
    await writeFile(join(root, "package.json"), "{}"); // node_modules only counts next to a manifest
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "index.js"), "12345");
    const result = JSON.parse(run("--json"));
    expect(result.findings[0].size).toBe(5);
    expect(result.errorCount).toBe(1);
    expect(run()).toContain("totals may be incomplete");
  });

  it("reports each unreadable path once when scanned paths overlap", async () => {
    const sub = join(root, "sub");
    const nested = join(sub, "blocked-too");
    await mkdir(nested, { recursive: true });
    await chmod(nested, 0);
    try {
      // `root` and `root/sub` both reach `sub/blocked-too`.
      const result = JSON.parse(run(sub, "--json"));
      expect(result.errors).toEqual(
        expect.arrayContaining([
          { path: blocked, code: "EACCES" },
          { path: nested, code: "EACCES" },
        ]),
      );
      expect(result.errorCount).toBe(2);
    } finally {
      await chmod(nested, 0o700);
    }
  });
});
