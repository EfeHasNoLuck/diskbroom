import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("cli", () => {
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
});
