import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, dirSize } from "../src/scanner.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "devsweep-test-"));

  // A JS project with node_modules.
  await mkdir(join(root, "webapp", "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "webapp", "node_modules", "left-pad", "index.js"), "x".repeat(1000));
  await writeFile(join(root, "webapp", "package.json"), "{}");
  await writeFile(join(root, "webapp", "app.js"), "console.log(1)");

  // A Rust project: `target` counts only because Cargo.toml sits next to it.
  await mkdir(join(root, "rustapp", "target", "debug"), { recursive: true });
  await writeFile(join(root, "rustapp", "target", "debug", "app"), "y".repeat(500));
  await writeFile(join(root, "rustapp", "Cargo.toml"), "[package]");

  // A folder literally named `target` that is NOT a Rust project — must be ignored.
  await mkdir(join(root, "archive", "target"), { recursive: true });
  await writeFile(join(root, "archive", "target", "notes.txt"), "z".repeat(300));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scan", () => {
  it("finds node_modules and reports a plausible size", async () => {
    const findings = await scan({ root });
    const nm = findings.find((f) => f.name === "node_modules");
    expect(nm).toBeDefined();
    expect(nm?.ecosystem).toBe("JavaScript");
    expect(nm?.confidence).toBe("high");
    expect(nm?.size).toBeGreaterThanOrEqual(1000);
  });

  it("matches Rust `target` only when a Cargo.toml sibling exists", async () => {
    const findings = await scan({ root });
    const targets = findings.filter((f) => f.name === "target");
    expect(targets).toHaveLength(1);
    expect(targets[0]?.path).toContain("rustapp");
  });

  it("never descends into a matched artifact", async () => {
    const findings = await scan({ root });
    const insideNodeModules = findings.some((f) => f.path.includes(join("node_modules", "left-pad")));
    expect(insideNodeModules).toBe(false);
  });

  it("sorts findings largest first", async () => {
    const findings = await scan({ root });
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1]!.size).toBeGreaterThanOrEqual(findings[i]!.size);
    }
  });
});

describe("dirSize", () => {
  it("sums the sizes of files in a tree", async () => {
    const size = await dirSize(join(root, "rustapp", "target"));
    expect(size).toBe(500);
  });

  it("counts every file exactly, even under concurrency (no races)", async () => {
    const many = join(root, "many-files");
    await mkdir(many, { recursive: true });
    const count = 250;
    const bytesEach = 100;
    await Promise.all(
      Array.from({ length: count }, (_, i) => writeFile(join(many, `f${i}.bin`), "a".repeat(bytesEach))),
    );
    // Run several times — a concurrency race would make this flaky / undercount.
    for (let run = 0; run < 3; run++) {
      expect(await dirSize(many)).toBe(count * bytesEach);
    }
  });
});
