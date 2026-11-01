import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "index.js"), "12345");
    const result = JSON.parse(run("--json"));
    expect(result.findings[0].size).toBe(5);
    expect(result.errorCount).toBe(1);
    expect(run()).toContain("totals may be incomplete");
  });
});
