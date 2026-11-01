import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { commonAncestor, prettyPath } from "../src/format.js";

const base = join(tmpdir(), "diskbroom-paths");

describe("commonAncestor", () => {
  it("returns a single path unchanged", () => {
    expect(commonAncestor([join(base, "a")])).toBe(join(base, "a"));
  });

  it("finds the shared parent of sibling folders", () => {
    expect(commonAncestor([join(base, "code", "web"), join(base, "code", "api"), join(base, "work")])).toBe(base);
  });

  it("returns the outer folder when one path contains the other", () => {
    expect(commonAncestor([join(base, "code"), join(base, "code", "app")])).toBe(join(base, "code"));
  });

  it("compares whole folder names, not string prefixes", () => {
    expect(commonAncestor([join(base, "code"), join(base, "code-old")])).toBe(base);
  });

  it("returns the filesystem root when that is all they share", () => {
    const fsRoot = parse(base).root; // "/" or e.g. "C:\\"
    expect(commonAncestor([join(fsRoot, "a", "b"), join(fsRoot, "c")])).toBe(fsRoot);
  });

  it.skipIf(process.platform !== "win32")("returns undefined for paths on different drives", () => {
    expect(commonAncestor(["C:\\code", "D:\\work"])).toBeUndefined();
  });

  it("returns undefined for no paths", () => {
    expect(commonAncestor([])).toBeUndefined();
  });
});

describe("prettyPath", () => {
  it("shows a path relative to the root, or in full without one", () => {
    expect(prettyPath(join(base, "code", "node_modules"), base)).toBe(join("code", "node_modules"));
    expect(prettyPath(join(base, "x"), undefined)).toBe(join(base, "x"));
  });
});
