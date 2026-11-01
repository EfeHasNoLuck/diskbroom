import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRemovable, removeArtifact, scan, type Finding } from "../src/scanner.js";

let root: string;

// Run git as a clean child: a GIT_DIR inherited from, say, a hook would point it elsewhere.
const GIT_ENV = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete GIT_ENV[key];
const HAS_GIT = spawnSync("git", ["--version"], { env: GIT_ENV }).status === 0;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Create files (and their parent folders) under `base`. */
async function makeFiles(base: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(base, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

/** Directory symlink that also works unprivileged on Windows (as a junction). */
async function linkDir(target: string, path: string): Promise<void> {
  await symlink(target, path, "junction");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findOne(scanRoot: string, name: string): Promise<Finding> {
  const finding = (await scan({ root: scanRoot })).find((f) => f.name === name);
  if (!finding) throw new Error(`fixture problem: no ${name} found under ${scanRoot}`);
  return finding;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "diskbroom-remove-"));
  await makeFiles(root, {
    "webapp/package.json": "{}",
    "webapp/app.js": "console.log(1)",
    "webapp/node_modules/left-pad/index.js": "x".repeat(1000),
    "rustapp/Cargo.toml": "[package]",
    "rustapp/target/debug/app": "y".repeat(500),
    "precious/keep.txt": "do not delete me",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("removeArtifact", () => {
  it("deletes the artifact folder and leaves the project's own files alone", async () => {
    const nm = await findOne(root, "node_modules");
    expect(await checkRemovable(nm, root)).toBeUndefined();

    const result = await removeArtifact(nm, root);

    expect(result.status).toBe("removed");
    expect(await exists(nm.path)).toBe(false);
    expect(await exists(join(root, "webapp", "package.json"))).toBe(true);
    expect(await exists(join(root, "webapp", "app.js"))).toBe(true);
    expect(await exists(join(root, "rustapp", "target"))).toBe(true);
  });

  it("removes symlinks inside the artifact without following them", async () => {
    await linkDir(join(root, "precious"), join(root, "webapp", "node_modules", "linked"));
    const nm = await findOne(root, "node_modules");

    const result = await removeArtifact(nm, root);

    expect(result.status).toBe("removed");
    expect(await exists(nm.path)).toBe(false);
    expect(await exists(join(root, "precious", "keep.txt"))).toBe(true);
  });

  it("refuses when the artifact was replaced by a symlink after the scan", async () => {
    const nm = await findOne(root, "node_modules");
    await rm(nm.path, { recursive: true });
    await linkDir(join(root, "precious"), nm.path);

    const result = await removeArtifact(nm, root);

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/symlink/);
    expect(await exists(join(root, "precious", "keep.txt"))).toBe(true);
  });

  it("refuses when a parent folder was swapped for a symlink after the scan", async () => {
    const scanRoot = join(root, "workspace");
    await makeFiles(scanRoot, { "app/package.json": "{}", "app/node_modules/x/index.js": "x" });
    const nm = await findOne(scanRoot, "node_modules");

    // Move the real project out of the scanned tree and leave a link in its place.
    const elsewhere = join(root, "elsewhere");
    await rename(join(scanRoot, "app"), elsewhere);
    await linkDir(elsewhere, join(scanRoot, "app"));

    const result = await removeArtifact(nm, scanRoot);

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/through a symlink/);
    expect(await exists(join(elsewhere, "node_modules", "x", "index.js"))).toBe(true);
  });

  it.each([
    ["a macOS app bundle", "Foo.app/Contents/Resources/app", { "Foo.app/Contents/Info.plist": "<plist/>" }, "Foo.app"],
    ["an Electron app", "foo/resources/app", { "foo/icudtl.dat": "x" }, "foo"],
  ])("never deletes anything inside %s, even when the scan starts there", async (_kind, inner, marker, label) => {
    await makeFiles(root, marker);
    const scanRoot = join(root, inner);
    await makeFiles(scanRoot, { "package.json": "{}", "node_modules/dep/index.js": "x" });
    const nm = await findOne(scanRoot, "node_modules");

    const result = await removeArtifact(nm, scanRoot);

    expect(result).toMatchObject({ status: "skipped", reason: `part of an installed app (${label})` });
    expect(await exists(nm.path)).toBe(true);
  });

  it.each(["Program Files", "site-packages", "dist-packages", ".cache", ".gradle", "node_modules", ".vscode"])(
    "never deletes anything inside a protected folder (%s)",
    async (protectedName) => {
      const scanRoot = join(root, protectedName, "tool");
      await makeFiles(scanRoot, { "package.json": "{}", "node_modules/dep/index.js": "x" });
      const nm = await findOne(scanRoot, "node_modules");

      const result = await removeArtifact(nm, scanRoot);

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe(`inside a protected folder (${protectedName})`);
      expect(await exists(nm.path)).toBe(true);
    },
  );

  it.skipIf(!HAS_GIT)("refuses a folder that contains files tracked by git", async () => {
    // A GitHub Action commits its bundled `dist/`; its node_modules is not committed.
    const repo = join(root, "action");
    await makeFiles(repo, { "package.json": "{}", "dist/index.js": "bundled", "node_modules/dep/index.js": "x" });
    git(repo, "init", "-q");
    git(repo, "add", "package.json", "dist/index.js");
    const dist = await findOne(repo, "dist");
    const nm = await findOne(repo, "node_modules");

    expect(await removeArtifact(dist, repo)).toMatchObject({
      status: "skipped",
      reason: "contains files tracked by git",
    });
    expect(await exists(join(repo, "dist", "index.js"))).toBe(true);
    expect((await removeArtifact(nm, repo)).status).toBe("removed");
  });

  it("refuses paths that are outside the scanned root, or the root itself", async () => {
    const nm = await findOne(root, "node_modules");

    const outside = await removeArtifact(nm, join(root, "rustapp"));
    const itself = await removeArtifact({ ...nm, path: root }, root);

    expect(outside).toMatchObject({ status: "skipped", reason: "outside the scanned folder" });
    expect(itself).toMatchObject({ status: "skipped", reason: "outside the scanned folder" });
    expect(await exists(nm.path)).toBe(true);
  });

  it("refuses when the folder no longer matches its rule", async () => {
    const target = await findOne(root, "target");
    await rm(join(root, "rustapp", "Cargo.toml"));

    const result = await removeArtifact(target, root);

    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/no longer matches/);
    expect(await exists(target.path)).toBe(true);
  });

  it("refuses a folder whose name is not a known artifact", async () => {
    const fake: Finding = {
      path: join(root, "precious"),
      name: "precious",
      ecosystem: "JavaScript",
      confidence: "high",
      size: 0,
      regenerate: undefined,
    };

    const result = await removeArtifact(fake, root);

    expect(result.status).toBe("skipped");
    expect(await exists(join(root, "precious", "keep.txt"))).toBe(true);
  });

  it("skips a folder that disappeared after the scan", async () => {
    const nm = await findOne(root, "node_modules");
    await rm(nm.path, { recursive: true });

    expect(await removeArtifact(nm, root)).toMatchObject({ status: "skipped", reason: "no longer exists" });
  });
});
