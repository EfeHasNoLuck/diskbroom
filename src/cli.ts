#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, type Finding } from "./scanner.js";
import { c, colorForSize, humanSize, table } from "./format.js";

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
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    console.error(c.red(`Error: ${(err as Error).message}`));
    console.error(`Run ${c.cyan("devsweep --help")} for usage.`);
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

  const root = resolve(positionals[0] ?? ".");

  const maxDepth = values.depth === undefined ? undefined : Number.parseInt(values.depth, 10);
  if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 0)) {
    console.error(c.red("Error: --depth must be a non-negative number."));
    process.exitCode = 1;
    return;
  }

  const top = values.top === undefined ? undefined : Number.parseInt(values.top, 10);

  const isTty = Boolean(process.stdout.isTTY);
  const showProgress = isTty && !values.json;
  const startedAt = Date.now();

  const findings = await scan({
    root,
    maxDepth,
    onProgress: showProgress ? makeProgress() : undefined,
  });

  if (showProgress) clearLine();
  const elapsed = Date.now() - startedAt;

  if (values.json) {
    console.log(JSON.stringify({ root, elapsedMs: elapsed, findings }, null, 2));
    return;
  }

  renderReport(findings, root, elapsed, top);
}

function renderReport(findings: Finding[], root: string, elapsed: number, top: number | undefined): void {
  const seconds = (elapsed / 1000).toFixed(1);

  if (findings.length === 0) {
    console.log(`${c.green("✓ No reclaimable build artifacts found.")} ${c.gray(`(scanned ${root} in ${seconds}s)`)}`);
    return;
  }

  const high = findings.filter((f) => f.confidence === "high");
  const medium = findings.filter((f) => f.confidence === "medium");

  const shown = top !== undefined && top > 0 ? findings.slice(0, top) : findings;
  const rows = shown.map((f) => [
    colorForSize(f.size, humanSize(f.size).padStart(9)),
    f.ecosystem,
    f.confidence === "high" ? c.green("high") : c.yellow("medium"),
    prettyPath(f.path, root),
  ]);

  console.log();
  console.log(table(["SIZE", "ECOSYSTEM", "CONFIDENCE", "PATH"], rows, ["right", "left", "left", "left"]));
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
  console.log(c.gray(`  scanned in ${seconds}s · devsweep only reports today; it never deletes anything.`));
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function prettyPath(path: string, root: string): string {
  const rel = relative(root, path);
  return rel === "" ? path : rel;
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
${c.bold("devsweep")} ${c.gray(`v${VERSION}`)} — find reclaimable build junk across your projects

${c.bold("USAGE")}
  devsweep [path] [options]

${c.bold("ARGUMENTS")}
  path             Directory to scan (default: current directory)

${c.bold("OPTIONS")}
  --top <n>        Show only the n largest findings
  --depth <n>      Limit how deep to descend
  --json           Output machine-readable JSON
  -h, --help       Show this help
  -v, --version    Show version

${c.bold("EXAMPLES")}
  ${c.cyan("devsweep")}                    ${c.gray("# scan the current folder")}
  ${c.cyan("devsweep ~/code --top 20")}    ${c.gray("# 20 biggest artifacts under ~/code")}
  ${c.cyan("devsweep . --json")}           ${c.gray("# JSON output for scripts/CI")}

${c.gray("devsweep only reports today — it never deletes anything.")}
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
