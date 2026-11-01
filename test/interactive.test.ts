import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scan, type Finding } from "../src/scanner.js";
import { MAX_SELECTION_ATTEMPTS, parseSelection, runInteractive } from "../src/interactive.js";

const ANSI = /\x1b\[[0-9;]*m/g;

function fakeFinding(confidence: Finding["confidence"], i: number): Finding {
  return { path: `/p/${i}`, root: "/p", name: "node_modules", ecosystem: "JavaScript", confidence, size: 100 - i, regenerate: undefined };
}

describe("parseSelection", () => {
  const list = [fakeFinding("high", 0), fakeFinding("medium", 1), fakeFinding("high", 2), fakeFinding("high", 3), fakeFinding("medium", 4)];

  it("accepts numbers and ranges, deduplicated and sorted", () => {
    expect(parseSelection("3, 1 2-4,1", list)).toEqual({ kind: "picked", indices: [0, 1, 2, 3] });
    expect(parseSelection("5", list)).toEqual({ kind: "picked", indices: [4] });
  });

  it("understands all and high", () => {
    expect(parseSelection("all", list)).toEqual({ kind: "picked", indices: [0, 1, 2, 3, 4] });
    expect(parseSelection(" ALL ", list)).toEqual({ kind: "picked", indices: [0, 1, 2, 3, 4] });
    expect(parseSelection("high", list)).toEqual({ kind: "picked", indices: [0, 2, 3] });
    expect(parseSelection("high", [fakeFinding("medium", 0)]).kind).toBe("invalid");
  });

  it("treats an empty answer, q, or none as cancel", () => {
    for (const answer of ["", "   ", "q", "none", ", ,"]) {
      expect(parseSelection(answer, list)).toEqual({ kind: "cancel" });
    }
  });

  it("rejects garbage, out-of-range numbers and backwards ranges", () => {
    for (const answer of ["foo", "0", "6", "2-9", "4-2", "1.5", "-1", "1,x"]) {
      expect(parseSelection(answer, list).kind).toBe("invalid");
    }
  });
});

describe("runInteractive", () => {
  let root: string;
  let findings: Finding[];
  let output: string[];

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Scripted answers; once they run out, input has "ended" (null). */
  function scripted(answers: string[]) {
    const asked: string[] = [];
    const ask = async (question: string): Promise<string | null> => {
      asked.push(question.replace(ANSI, ""));
      return answers.shift() ?? null;
    };
    return { ask, asked };
  }

  const print = (line = "") => output.push(line.replace(ANSI, ""));
  const text = () => output.join("\n");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "diskbroom-interactive-"));
    const files: Record<string, string> = {
      "big/package.json": "{}",
      "big/node_modules/a/index.js": "a".repeat(3000),
      "rust/Cargo.toml": "[package]",
      "rust/target/debug/app": "b".repeat(2000),
      "site/package.json": "{}",
      "site/dist/bundle.js": "c".repeat(1000),
    };
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    findings = await scan({ root }); // largest first: node_modules, target, dist
    output = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is a dry run by default: reports the space but deletes nothing", async () => {
    const { ask, asked } = scripted(["all"]);

    const result = await runInteractive({ findings, displayRoot: root, delete: false, ask, print });

    expect(result.outcome).toBe("dry-run");
    expect(result.selected).toHaveLength(3);
    expect(asked).toHaveLength(1); // no confirmation needed for a dry run
    for (const f of findings) expect(await exists(f.path)).toBe(true);
    expect(text()).toContain("Dry run — nothing was deleted");
    expect(text()).toContain("--delete");
  });

  it("deletes only the picked folders after the user types yes", async () => {
    const { ask, asked } = scripted(["1,3", "yes"]);

    const result = await runInteractive({ findings, displayRoot: root, delete: true, ask, print });

    expect(result.outcome).toBe("deleted");
    expect(result.results.map((r) => r.status)).toEqual(["removed", "removed"]);
    expect(asked[1]).toMatch(/Permanently delete 2 folders/);
    expect(await exists(join(root, "big", "node_modules"))).toBe(false);
    expect(await exists(join(root, "site", "dist"))).toBe(false);
    expect(await exists(join(root, "rust", "target"))).toBe(true); // not picked
    expect(await exists(join(root, "big", "package.json"))).toBe(true);
    expect(text()).toContain("medium-confidence folder selected"); // dist is medium
    expect(text()).toMatch(/Freed .* across 2 folders/);
  });

  it.each([["y"], ["no"], [""], ["yes please"]])("cancels unless the confirmation is exactly yes (%j)", async (answer) => {
    const { ask } = scripted(["all", answer]);

    const result = await runInteractive({ findings, displayRoot: root, delete: true, ask, print });

    expect(result.outcome).toBe("cancelled");
    for (const f of findings) expect(await exists(f.path)).toBe(true);
    expect(text()).toContain("Nothing was deleted");
  });

  it("cancels when input ends, at either prompt", async () => {
    const atSelection = await runInteractive({ findings, displayRoot: root, delete: true, ask: scripted([]).ask, print });
    const atConfirm = await runInteractive({ findings, displayRoot: root, delete: true, ask: scripted(["1"]).ask, print });

    expect(atSelection.outcome).toBe("cancelled");
    expect(atConfirm.outcome).toBe("cancelled");
    for (const f of findings) expect(await exists(f.path)).toBe(true);
  });

  it("re-asks after an invalid selection, then gives up", async () => {
    const retry = scripted(["9", "2", "yes"]);
    const ok = await runInteractive({ findings, displayRoot: root, delete: true, ask: retry.ask, print });
    expect(ok.outcome).toBe("deleted");
    expect(await exists(join(root, "rust", "target"))).toBe(false);

    const bad = scripted(Array.from({ length: 10 }, () => "nope"));
    const gaveUp = await runInteractive({ findings, displayRoot: root, delete: true, ask: bad.ask, print });
    expect(gaveUp.outcome).toBe("invalid");
    expect(bad.asked).toHaveLength(MAX_SELECTION_ATTEMPTS);
    expect(await exists(join(root, "big", "node_modules"))).toBe(true);
  });

  it("checks each finding against its own scan root, not the shared display folder", async () => {
    // Two scanned paths, plus a finding forged to claim a root it isn't inside.
    const own = [...(await scan({ root: join(root, "big") })), ...(await scan({ root: join(root, "rust") }))];
    const [dist] = await scan({ root: join(root, "site") });
    if (dist === undefined) throw new Error("fixture problem: no site/dist");
    const forged: Finding = { ...dist, root: join(root, "rust") };
    const { ask, asked } = scripted(["all", "yes"]);

    const result = await runInteractive({ findings: [...own, forged], displayRoot: root, delete: true, ask, print });

    // The preview already tells the truth, so the confirmation counts only what will go.
    expect(text()).toMatch(/site.dist .*will be skipped: outside the scanned folder/);
    expect(asked[1]).toMatch(/Permanently delete 2 folders/);
    expect(result.results.map((r) => r.status)).toEqual(["removed", "removed", "skipped"]);
    expect(result.results[2]?.reason).toBe("outside the scanned folder");
    expect(await exists(join(root, "site", "dist"))).toBe(true);
  });

  it("previews unsafe picks as skipped and leaves them out of the confirmation", async () => {
    await rm(join(root, "rust", "Cargo.toml")); // `target` no longer qualifies
    const { ask, asked } = scripted(["1-2", "yes"]);

    const result = await runInteractive({ findings, displayRoot: root, delete: true, ask, print });

    expect(text()).toMatch(/rust.target .*will be skipped: no longer matches/);
    expect(asked[1]).toMatch(/Permanently delete 1 folder /);
    expect(result.results.map((r) => r.status)).toEqual(["removed", "skipped"]);
    expect(await exists(join(root, "rust", "target"))).toBe(true);
  });
});
