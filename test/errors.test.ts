import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scanner.js";

const failures = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: (...args: Parameters<typeof fs.readdir>) => {
      const code = failures.get(String(args[0]));
      if (code) return Promise.reject(Object.assign(new Error(code), { code }));
      return fs.readdir(...args);
    },
    stat: (...args: Parameters<typeof fs.stat>) => {
      const code = failures.get(String(args[0]));
      if (code) return Promise.reject(Object.assign(new Error(code), { code }));
      return fs.stat(...args);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diskbroom-errors-"));
});
afterEach(async () => {
  failures.clear();
  await rm(root, { recursive: true, force: true });
});

describe("incomplete scans", () => {
  it("reports an unreadable scan root", async () => {
    failures.set(root, "EACCES");
    expect(await scan({ root })).toEqual({ findings: [], errors: [{ path: root, code: "EACCES" }] });
  });

  it("keeps readable findings while reporting traversal, nested size and file stat failures", async () => {
    const blocked = join(root, "blocked");
    const artifact = join(root, "node_modules");
    const nested = join(artifact, "private");
    const vanished = join(artifact, "gone.js");
    await mkdir(blocked);
    await mkdir(nested, { recursive: true });
    await writeFile(join(artifact, "readable.js"), "12345");
    await writeFile(vanished, "123");
    failures.set(blocked, "EACCES");
    failures.set(nested, "EPERM");
    failures.set(vanished, "ENOENT");

    const { findings, errors } = await scan({ root });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.size).toBe(5);
    expect(errors).toHaveLength(3);
    expect(errors).toEqual(expect.arrayContaining([
      { path: blocked, code: "EACCES" },
      { path: nested, code: "EPERM" },
      { path: vanished, code: "ENOENT" },
    ]));
  });

  it("reports an unreadable rule marker directory only once", async () => {
    const venv = join(root, "venv");
    await mkdir(venv);
    failures.set(venv, "EACCES");
    const result = await scan({ root });
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([{ path: venv, code: "EACCES" }]);
  });

  it("does not report intentionally skipped directories", async () => {
    const git = join(root, ".git");
    await mkdir(git);
    failures.set(git, "EACCES");
    expect((await scan({ root })).errors).toEqual([]);
  });
});
