import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RULES, type ArtifactRule, type Confidence } from "./patterns.js";

export interface Finding {
  /** Absolute path to the artifact directory. */
  path: string;
  /** The scan root it was found under. Deletion re-checks that it is still inside. */
  root: string;
  /** Directory base name, e.g. "node_modules". */
  name: string;
  ecosystem: string;
  confidence: Confidence;
  /** Total size in bytes of every file underneath. */
  size: number;
  /** Command that regenerates it, if known. */
  regenerate: string | undefined;
}

export interface ScanOptions {
  root: string;
  /** Maximum directory depth to descend (relative to root). Default: unlimited. */
  maxDepth?: number;
  /** Called as directories are scanned, for progress display. */
  onProgress?: (dirsScanned: number, currentPath: string) => void;
}

export interface ScanError {
  path: string;
  code: string;
}

export interface ScanResult {
  findings: Finding[];
  errors: ScanError[];
}

type OnError = (path: string, error: unknown) => void;

const RULE_BY_NAME = new Map<string, ArtifactRule>();
for (const rule of RULES) RULE_BY_NAME.set(rule.name.toLowerCase(), rule);

/**
 * Directories we never descend into, and never delete anything underneath.
 * A folder with one of these names is still reported when it matches a rule
 * itself (a project's own `node_modules` or `.gradle`); it is never walked into.
 */
const SKIP_DIRS = new Set([
  // Version-control internals.
  ".git",
  ".hg",
  ".svn",
  // Windows system folders and recycle bins.
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$windows.~bt",
  "$windows.~ws",
  // Installed-package trees and tool caches. They're never a user's project,
  // and anything artifact-shaped inside belongs to an installed package (npm's
  // bundled dependencies, the `dist/` pyright ships) or to a cache.
  "node_modules",
  "site-packages",
  "dist-packages",
  ".cache",
  ".gradle",
  // Editor extension and remote-server installs (`~/.vscode/extensions`, …).
  // Extensions ship their own `node_modules` and `dist/` that no project
  // command regenerates. A project's own `.vscode` only holds settings.
  ".vscode",
  ".vscode-insiders",
  ".vscode-oss",
  ".vscode-server",
  ".vscode-server-insiders",
  ".cursor",
  ".cursor-server",
  ".windsurf",
  ".windsurf-server",
]);

/** Chromium runtime files that sit next to an installed Electron app's `resources` folder. */
const CHROMIUM_FILES = ["resources.pak", "icudtl.dat", "chrome_100_percent.pak", "v8_context_snapshot.bin"];

/**
 * If `dir` holds installed software rather than a project, return its name:
 *  - a macOS app bundle (`Visual Studio Code.app`, with `Contents/Info.plist`);
 *  - an Electron app's packaged code (`resources/app` or
 *    `resources/app.asar.unpacked` next to Chromium's runtime files), such as
 *    `/usr/share/code/resources/app` or `AppData\Local\Programs\<App>\resources\app`.
 * It only touches the disk when the folder names match, so it is cheap to call
 * for every directory. A project merely named `todo.app`, or a Java project's
 * `src/main/resources/app`, doesn't qualify.
 */
async function installedApp(dir: string): Promise<string | undefined> {
  const name = basename(dir);
  const lower = name.toLowerCase();
  if (lower.endsWith(".app")) {
    return (await isFile(join(dir, "Contents", "Info.plist"))) ? name : undefined;
  }
  if ((lower === "app" || lower === "app.asar.unpacked") && basename(dirname(dir)).toLowerCase() === "resources") {
    const appRoot = dirname(dirname(dir));
    return (await containsAnyOf(appRoot, CHROMIUM_FILES)) ? basename(appRoot) : undefined;
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function containsAnyOf(dir: string, names: string[]): Promise<boolean> {
  try {
    const present = new Set((await readdir(dir)).map((n) => n.toLowerCase()));
    return names.some((n) => present.has(n));
  } catch {
    return false;
  }
}

/**
 * Walk `root`, returning every regenerable artifact directory it finds. Never
 * follows symlinks, never descends into a matched artifact, a SKIP_DIRS folder
 * or installed software, and records unreadable paths instead of failing, so
 * one inaccessible folder can't abort the whole scan.
 */
export async function scan(options: ScanOptions): Promise<ScanResult> {
  const { root, onProgress } = options;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const findings: Finding[] = [];
  const errors = new Map<string, ScanError>();
  const onError: OnError = (path, error) => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    errors.set(path, { path, code });
  };
  let dirsScanned = 0;

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.pop();
    if (item === undefined) break;
    const { dir, depth } = item;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      onError(dir, error);
      continue; // permission denied, path vanished, etc.
    }

    dirsScanned++;
    onProgress?.(dirsScanned, dir);

    const siblingNames = entries.map((entry) => entry.name);

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;

      const lower = entry.name.toLowerCase();
      const full = join(dir, entry.name);
      const rule = RULE_BY_NAME.get(lower);

      if (rule && (await ruleMatches(rule, siblingNames, full, onError))) {
        findings.push({
          path: full,
          root,
          name: entry.name,
          ecosystem: rule.ecosystem,
          confidence: rule.confidence,
          size: await dirSize(full, onError),
          regenerate: rule.regenerate,
        });
        continue; // do not descend into a matched artifact
      }

      if (SKIP_DIRS.has(lower)) continue;
      if ((await installedApp(full)) !== undefined) continue;
      if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }

  findings.sort((a, b) => b.size - a.size);
  return { findings, errors: [...errors.values()] };
}

async function ruleMatches(rule: ArtifactRule, siblingNames: string[], full: string, onError?: OnError): Promise<boolean> {
  if (rule.requiresSibling && !hasSibling(siblingNames, rule.requiresSibling)) return false;
  if (rule.requiresInner && !(await existsInside(full, rule.requiresInner, onError))) return false;
  return true;
}

function hasSibling(siblingNames: string[], patterns: string[]): boolean {
  const lowerNames = siblingNames.map((n) => n.toLowerCase());
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1).toLowerCase(); // ".csproj"
      return lowerNames.some((n) => n.endsWith(ext));
    }
    return lowerNames.includes(pattern.toLowerCase());
  });
}

async function existsInside(dir: string, fileName: string, onError?: OnError): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const target = fileName.toLowerCase();
    return entries.some((entry) => entry.name.toLowerCase() === target);
  } catch (error) {
    onError?.(dir, error);
    return false;
  }
}

/** Sum the size of every regular file under `root`, skipping symlinks. */
export async function dirSize(root: string, onError?: OnError): Promise<number> {
  let total = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      onError?.(dir, error);
      continue;
    }

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
    total += await sumSizes(files, onError);
  }

  return total;
}

/**
 * Stat many files with bounded concurrency to avoid exhausting file handles.
 * Each worker keeps its OWN subtotal — a shared `total += await …` would race
 * across the await boundary and silently undercount.
 */
async function sumSizes(files: string[], onError?: OnError, limit = 64): Promise<number> {
  let index = 0;

  const worker = async (): Promise<number> => {
    let local = 0;
    while (index < files.length) {
      const file = files[index++];
      if (file === undefined) break;
      try {
        local += (await stat(file)).size;
      } catch (error) {
        onError?.(file, error);
      }
    }
    return local;
  };

  const workerCount = Math.min(limit, files.length);
  const subtotals = await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return subtotals.reduce((sum, value) => sum + value, 0);
}

export type RemovalStatus = "removed" | "skipped" | "failed";

export interface RemovalResult {
  finding: Finding;
  status: RemovalStatus;
  /** Why the folder was skipped or why removal failed. */
  reason?: string;
}

/**
 * Re-check, right before deletion, that a finding is still safe to remove.
 * Returns `undefined` when it is, or a short human-readable reason when not.
 *
 * The scan may be minutes old by the time the user confirms, so nothing from
 * it is trusted blindly. A folder is only removable when:
 *  - it sits strictly inside the scanned `root`;
 *  - no folder on its path is a protected folder (see SKIP_DIRS) or installed
 *    software such as an app bundle (see `installedApp`);
 *  - neither it nor any folder between it and `root` is a symlink or junction;
 *  - it is still a directory that matches its artifact rule (e.g. `target`
 *    still has a `Cargo.toml` next to it);
 *  - git, when available, tracks no files inside it, so committed output such
 *    as a GitHub Action's `dist/` is never deleted.
 */
export async function checkRemovable(finding: Finding, root: string = finding.root): Promise<string | undefined> {
  const absRoot = resolve(root);
  const target = resolve(finding.path);
  const rel = relative(absRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return "outside the scanned folder";
  }

  const protectedDir = target
    .split(sep)
    .slice(0, -1)
    .find((segment) => SKIP_DIRS.has(segment.toLowerCase()));
  if (protectedDir !== undefined) return `inside a protected folder (${protectedDir})`;

  // Checked all the way up, so this holds even when the scan started inside an app.
  for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
    const app = await installedApp(dir);
    if (app !== undefined) return `part of an installed app (${app})`;
  }

  // Walk from the root down to the target with lstat, so a folder swapped for
  // a symlink after the scan can never redirect the delete somewhere else.
  let current = absRoot;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return "no longer exists";
    }
    if (info.isSymbolicLink()) {
      return current === target ? "is now a symlink" : "its path now goes through a symlink";
    }
    if (!info.isDirectory()) return "is no longer a directory";
  }

  const rule = RULE_BY_NAME.get(basename(target).toLowerCase());
  if (!rule) return "is not a known artifact folder";

  let siblingNames: string[];
  try {
    siblingNames = await readdir(dirname(target));
  } catch {
    return "its parent folder is unreadable";
  }
  if (!(await ruleMatches(rule, siblingNames, target))) {
    return "no longer matches its rule (project marker is gone)";
  }

  // Last, because it starts a process.
  if (await containsTrackedFiles(target)) return "contains files tracked by git";
  return undefined;
}

/** Give up on git after this long and treat the folder as untracked. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Does git track any file inside `dir`? Only `true` when git positively lists
 * one. Not being in a repository, or git being missing or failing, counts as
 * `false`: this guard is best-effort, and every other check still applies.
 */
function containsTrackedFiles(dir: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    // These would point git at some other repository than the one `dir` is in.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];

    let found = false;
    let child: ChildProcess;
    try {
      child = spawn("git", ["ls-files", "-z", "--", "."], {
        cwd: dir,
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolvePromise(false);
      return;
    }

    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      resolvePromise(found);
    };
    child.stdout?.on("data", () => {
      found = true;
      child.kill(); // one tracked file is enough
    });
    child.on("error", finish);
    child.on("close", finish);
  });
}

/**
 * Permanently delete one artifact found by `scan`, after re-running every
 * `checkRemovable` safety check. Symlinks and junctions met inside the folder
 * are unlinked, never followed, so their targets are left untouched.
 */
export async function removeArtifact(finding: Finding, root: string = finding.root): Promise<RemovalResult> {
  const reason = await checkRemovable(finding, root);
  if (reason !== undefined) return { finding, status: "skipped", reason };

  try {
    await rm(finding.path, { recursive: true, maxRetries: 3 });
    return { finding, status: "removed" };
  } catch (err) {
    return { finding, status: "failed", reason: describeRemovalError(err) };
  }
}

function describeRemovalError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const detail =
    code === "EACCES" || code === "EPERM"
      ? "permission denied"
      : code === "EBUSY"
        ? "a file is in use"
        : (err as Error).message;
  return `${detail} (it may be partially removed)`;
}
