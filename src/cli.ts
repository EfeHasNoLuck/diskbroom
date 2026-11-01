#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { scan, type Finding } from "./scanner.js";
import { c, colorForSize, commonAncestor, humanSize, plural, prettyPath, table } from "./format.js";
import { runInteractive, type Ask } from "./interactive.js";

const VERSION = readVersion();

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        depth: { type: "string" },
        top: { type: "string" },
        interactive: { type: "boolean", short: "i", default: false },
        delete: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    console.error(c.red(`Error: ${(err as Error).message}`));
    console.error(`Run ${c.cyan("diskbroom --help")} for usage.`);
    process.exitCode = 1;
    return;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(VERSION);
    return;
  }
  if (values.help) {
    printHelp();
    return;
  }

  if (values.delete && !values.interactive) {
    console.error(c.red("Error: --delete only works together with --interactive (-i), so you always pick what goes."));
    process.exitCode = 1;
    return;
  }
  if (values.interactive && values.json) {
    console.error(c.red("Error: --interactive can't be combined with --json."));
    process.exitCode = 1;
    return;
  }

  // Every path given (the current folder when none is), resolved and de-duplicated.
  const roots = [...new Set((positionals.length > 0 ? positionals : ["."]).map((p) => resolve(p)))];

  for (const root of roots) {
    try {
      const rootStat = await stat(root);
      if (!rootStat.isDirectory()) {
        console.error(c.red(`Error: not a directory: ${root}`));
        process.exitCode = 1;
        return;
      }
    } catch {
      console.error(c.red(`Error: path does not exist: ${root}`));
      process.exitCode = 1;
      return;
    }
  }

  const maxDepth = values.depth === undefined ? undefined : Number.parseInt(values.depth, 10);
  if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 0)) {
    console.error(c.red("Error: --depth must be a non-negative number."));
    process.exitCode = 1;
    return;
  }

  const top = values.top === undefined ? undefined : Number.parseInt(values.top, 10);
  if (top !== undefined && (!Number.isFinite(top) || top < 1)) {
    console.error(c.red("Error: --top must be a positive number."));
    process.exitCode = 1;
    return;
  }

  const isTty = Boolean(process.stdout.isTTY);
  const showProgress = isTty && !values.json;
  const startedAt = Date.now();

  const onProgress = showProgress ? makeProgress() : undefined;
  const byPath = new Map<string, Finding>();
  for (const root of roots) {
    for (const finding of await scan({ root, maxDepth, onProgress })) {
      // Overlapping paths (`~/code ~/code/app`) find the same folder twice; keep the first.
      if (!byPath.has(finding.path)) byPath.set(finding.path, finding);
    }
  }
  const findings = [...byPath.values()].sort((a, b) => b.size - a.size);

  if (showProgress) clearLine();
  const elapsed = Date.now() - startedAt;

  if (values.json) {
    // `root` predates multiple paths; it stays (as the first one) for existing scripts.
    console.log(JSON.stringify({ root: roots[0], roots, elapsedMs: elapsed, findings }, null, 2));
    return;
  }

  const shown = top !== undefined && top > 0 ? findings.slice(0, top) : findings;
  // Paths are shown relative to the folder all scanned paths share.
  const displayRoot = commonAncestor(roots);
  renderReport(findings, shown, roots, displayRoot, elapsed, values.interactive);
  if (!values.interactive || shown.length === 0) return;

  const prompt = createPrompt();
  try {
    const result = await runInteractive({
      findings: shown,
      displayRoot,
      delete: values.delete,
      ask: prompt.ask,
      print: (line = "") => console.log(line),
    });
    if (result.outcome === "invalid" || result.results.some((r) => r.status !== "removed")) {
      process.exitCode = 1;
    }
  } finally {
    prompt.close();
  }
}

function renderReport(
  findings: Finding[],
  shown: Finding[],
  roots: string[],
  displayRoot: string | undefined,
  elapsed: number,
  numbered: boolean,
): void {
  const seconds = (elapsed / 1000).toFixed(1);

  if (findings.length === 0) {
    console.log(`${c.green("✓ No reclaimable build artifacts found.")} ${c.gray(`(scanned ${roots.join(", ")} in ${seconds}s)`)}`);
    return;
  }

  const high = findings.filter((f) => f.confidence === "high");
  const medium = findings.filter((f) => f.confidence === "medium");

  const rows = shown.map((f, i) => [
    ...(numbered ? [c.cyan(String(i + 1).padStart(3))] : []),
    colorForSize(f.size, humanSize(f.size).padStart(9)),
    f.ecosystem,
    f.confidence === "high" ? c.green("high") : c.yellow("medium"),
    prettyPath(f.path, displayRoot),
  ]);
  const headers = [...(numbered ? ["#"] : []), "SIZE", "ECOSYSTEM", "CONFIDENCE", "PATH"];
  const aligns: Array<"left" | "right"> = [...(numbered ? ["right" as const] : []), "right", "left", "left", "left"];

  console.log();
  console.log(table(headers, rows, aligns));
  if (shown.length < findings.length) {
    console.log(c.gray(`  … and ${findings.length - shown.length} more (drop --top to see all)`));
  }

  console.log();
  console.log(`${c.gray("  by ecosystem:  ")}${ecosystemBreakdown(findings)}`);
  console.log();
  console.log(
    `  ${c.bold(humanSize(sumSize(high)))} ${c.green("reclaimable")} ${c.gray(`across ${plural(high.length, "high-confidence folder")}`)}`,
  );
  if (medium.length > 0) {
    console.log(
      `  ${c.bold(humanSize(sumSize(medium)))} ${c.yellow("more")} ${c.gray(`in ${plural(medium.length, "medium-confidence folder")} — review before removing`)}`,
    );
  }
  console.log();
  if (numbered) {
    console.log(c.gray(`  scanned in ${seconds}s`));
  } else {
    console.log(c.gray(`  scanned in ${seconds}s · nothing was deleted — use -i to pick folders to remove`));
  }
}

function ecosystemBreakdown(findings: Finding[]): string {
  const totals = new Map<string, number>();
  for (const f of findings) totals.set(f.ecosystem, (totals.get(f.ecosystem) ?? 0) + f.size);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([eco, size]) => `${eco} ${c.bold(humanSize(size))}`)
    .join(c.gray("  ·  "));
}

function sumSize(findings: Finding[]): number {
  return findings.reduce((acc, f) => acc + f.size, 0);
}

/**
 * Line-based prompt on stdin. Answers can also be piped in (one per line);
 * end of input or Ctrl+C resolves to `null`, which always means "cancel".
 */
function createPrompt(): { ask: Ask; close: () => void } {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
  // The async iterator buffers lines, so piped answers are never dropped.
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.on("SIGINT", () => rl.close()); // Ctrl+C at a prompt cancels instead of hanging

  const ask: Ask = async (question) => {
    // Piped input closes the interface at EOF while answers may still be
    // buffered in the iterator, so `closed` must not short-circuit here.
    if (terminal && !closed) {
      rl.setPrompt(question);
      rl.prompt();
    } else {
      process.stdout.write(question);
    }
    const next = await lines.next();
    if (next.done) {
      process.stdout.write("\n");
      return null;
    }
    if (!terminal) process.stdout.write(`${next.value}\n`); // echo piped answers so the log reads naturally
    return next.value;
  };
  return { ask, close: () => rl.close() };
}

function makeProgress(): (dirsScanned: number, currentPath: string) => void {
  let last = 0;
  return (dirsScanned, currentPath) => {
    const now = Date.now();
    if (now - last < 80) return;
    last = now;
    const label = currentPath.length > 58 ? `…${currentPath.slice(-57)}` : currentPath;
    process.stdout.write(`\r${c.gray(`  scanning… ${dirsScanned} dirs  ${label}`)}\x1b[K`);
  };
}

function clearLine(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

function printHelp(): void {
  console.log(`
${c.bold("diskbroom")} ${c.gray(`v${VERSION}`)} — find reclaimable build junk across your projects

${c.bold("USAGE")}
  diskbroom [path...] [options]

${c.bold("ARGUMENTS")}
  path...            One or more directories to scan (default: current directory)

${c.bold("OPTIONS")}
  -i, --interactive  Pick folders from the results to remove (a dry run by default)
  --delete           With -i: really delete the picked folders, after you type "yes"
  --top <n>          Show only the n largest findings
  --depth <n>        Limit how deep to descend
  --json             Output machine-readable JSON
  -h, --help         Show this help
  -v, --version      Show version

${c.bold("EXAMPLES")}
  ${c.cyan("diskbroom")}                       ${c.gray("# scan the current folder")}
  ${c.cyan("diskbroom ~/code --top 20")}       ${c.gray("# 20 biggest artifacts under ~/code")}
  ${c.cyan("diskbroom ~/code ~/work")}         ${c.gray("# scan several folders in one go")}
  ${c.cyan("diskbroom . --json")}              ${c.gray("# JSON output for scripts/CI")}
  ${c.cyan("diskbroom ~/code -i")}             ${c.gray("# pick folders, preview the space you'd free")}
  ${c.cyan("diskbroom ~/code -i --delete")}    ${c.gray("# pick folders, confirm, delete them")}

${c.gray('diskbroom never deletes anything unless you pass -i --delete and type "yes".')}
`);
}

function readVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

main().catch((err) => {
  console.error(c.red(`Unexpected error: ${(err as Error).message}`));
  process.exitCode = 1;
});
