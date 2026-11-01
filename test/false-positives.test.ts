import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { scan } from "../src/scanner.js";

// Layouts copied from real installs on a dev machine, where earlier versions
// reported folders as reclaimable that `npm install` & co. can't bring back.
const FILES: Record<string, string> = {
  // Node's global install: npm, corepack & co. live in lib/node_modules with no
  // package.json next to it, and npm bundles its own dependencies inside.
  "opt/node22/lib/node_modules/npm/package.json": "{}",
  "opt/node22/lib/node_modules/npm/node_modules/abbrev/package.json": "{}",
  "opt/node22/lib/node_modules/corepack/package.json": "{}",
  // A tool's test fixtures: mock node_modules folders without a manifest.
  "opt/nvm/test/mocks/project_dirs/nested-n_m/node_modules/foo/index.js": "x",
  // pyright, installed as a uv tool, ships an npm package inside site-packages,
  // so its `dist/dist` sits next to a package.json.
  "home/.local/share/uv/tools/pyright/lib/python3.13/site-packages/pyright/dist/package.json": "{}",
  "home/.local/share/uv/tools/pyright/lib/python3.13/site-packages/pyright/dist/dist/pyright.js": "x",
  "home/.local/lib/python3.13/site-packages/jinja2/__pycache__/x.pyc": "x",
  "usr/lib/python3/dist-packages/yaml/__pycache__/x.pyc": "x",
  // The same pyright files, unpacked in uv's cache.
  "home/.cache/uv/archive-v0/abc/pyright/dist/package.json": "{}",
  "home/.cache/uv/archive-v0/abc/pyright/dist/dist/pyright.js": "x",
  // The Gradle *user home*: settings and credentials, not a build cache.
  "home/.gradle/gradle.properties": "signing.password=secret",
  "home/.gradle/caches/modules-2/files-2.1/lib.jar": "x",
  // Hand-written source that merely shares an artifact's name: the rbs gem's
  // type signatures for Ruby's `coverage` module, and plain notes.
  "opt/ruby/lib/ruby/gems/3.3.0/gems/rbs-3.4.0/stdlib/coverage/0/coverage.rbs": "module Coverage end",
  "home/docs/coverage/policy.md": "x",
  "home/scratch/node_modules/notes.txt": "x",
  // Real projects, which must still be found.
  "home/code/webapp/package.json": "{}",
  "home/code/webapp/node_modules/dep/index.js": "x",
  "home/code/webapp/coverage/lcov.info": "x",
  "home/code/denoapp/deno.json": "{}",
  "home/code/denoapp/node_modules/dep/index.js": "x",
  "home/code/android/settings.gradle.kts": "",
  "home/code/android/.gradle/8.14/fileHashes.bin": "x",
};

let root: string;
/** Finding paths relative to `root`, with forward slashes, sorted. */
let found: string[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "diskbroom-fp-"));
  for (const [rel, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  found = (await scan({ root }))
    .map((f) => relative(root, f.path).split(sep).join("/"))
    .sort();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scan ignores folders that belong to installed tools", () => {
  it("finds the real projects' artifacts and nothing else", () => {
    expect(found).toEqual([
      "home/code/android/.gradle",
      "home/code/denoapp/node_modules",
      "home/code/webapp/coverage",
      "home/code/webapp/node_modules",
    ]);
  });

  it("skips Node's global install and npm's bundled dependencies", () => {
    expect(found.filter((p) => p.startsWith("opt/node22/"))).toEqual([]);
  });

  it("never looks inside installed Python packages or caches", () => {
    expect(found.filter((p) => /site-packages|dist-packages|\.cache/.test(p))).toEqual([]);
  });

  it("skips the Gradle user home but finds a project's .gradle", () => {
    expect(found).not.toContain("home/.gradle");
    expect(found).toContain("home/code/android/.gradle");
  });

  it("only flags coverage and node_modules next to a JS manifest", () => {
    expect(found.filter((p) => p.includes("rbs-3.4.0") || p.startsWith("home/docs/"))).toEqual([]);
    expect(found).not.toContain("home/scratch/node_modules");
    expect(found.filter((p) => p.startsWith("opt/nvm/"))).toEqual([]);
  });
});
