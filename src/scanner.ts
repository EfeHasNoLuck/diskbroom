import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { RULES, type ArtifactRule, type Confidence } from "./patterns.js";

export interface Finding {
  /** Absolute path to the artifact directory. */
  path: string;
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

/** Directories we never descend into (VCS internals, system, recycle bins). */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "$windows.~bt",
  "$windows.~ws",
]);

/**
 * Walk `root`, returning every regenerable artifact directory it finds. Never
 * follows symlinks or descends into a matched artifact. Records unreadable paths
 * and continues so one inaccessible folder can't abort the whole scan.
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
          name: entry.name,
          ecosystem: rule.ecosystem,
          confidence: rule.confidence,
          size: await dirSize(full, onError),
          regenerate: rule.regenerate,
        });
        continue; // do not descend into a matched artifact
      }

      if (SKIP_DIRS.has(lower)) continue;
      if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }

  findings.sort((a, b) => b.size - a.size);
  return { findings, errors: [...errors.values()] };
}

async function ruleMatches(rule: ArtifactRule, siblingNames: string[], full: string, onError: OnError): Promise<boolean> {
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

async function existsInside(dir: string, fileName: string, onError: OnError): Promise<boolean> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const target = fileName.toLowerCase();
    return entries.some((entry) => entry.name.toLowerCase() === target);
  } catch (error) {
    onError(dir, error);
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
