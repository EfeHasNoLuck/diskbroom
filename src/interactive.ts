// Interactive selection + (opt-in) deletion. Kept free of process I/O so the
// whole flow can be driven from tests with scripted answers.

import { checkRemovable, removeArtifact, type Finding, type RemovalResult } from "./scanner.js";
import { c, colorForSize, humanSize, plural, prettyPath, table } from "./format.js";

/** Ask one question; resolves to the answer, or `null` once input has ended (Ctrl+D / Ctrl+C). */
export type Ask = (question: string) => Promise<string | null>;
export type Print = (line?: string) => void;

export type Selection =
  | { kind: "cancel" }
  | { kind: "picked"; indices: number[] }
  | { kind: "invalid"; message: string };

/** The only answer that confirms a real deletion. "y" is deliberately not enough. */
export const CONFIRM_WORD = "yes";

/** Invalid selections allowed before giving up (also stops a piped `yes` looping forever). */
export const MAX_SELECTION_ATTEMPTS = 3;

const CANCEL_WORDS = new Set(["", "q", "quit", "n", "no", "none"]);
const ALL_WORDS = new Set(["a", "all", "*"]);

/**
 * Parse an answer like `1,3 5-7`, `all`, or `high` into 0-based indices into
 * `findings`. An empty answer (or `q`/`none`) cancels.
 */
export function parseSelection(answer: string, findings: readonly Finding[]): Selection {
  const text = answer.trim().toLowerCase();
  if (CANCEL_WORDS.has(text)) return { kind: "cancel" };
  if (ALL_WORDS.has(text)) return { kind: "picked", indices: findings.map((_, i) => i) };
  if (text === "high") {
    const indices = findings.flatMap((f, i) => (f.confidence === "high" ? [i] : []));
    return indices.length > 0
      ? { kind: "picked", indices }
      : { kind: "invalid", message: "There are no high-confidence folders in the list." };
  }

  const picked = new Set<number>();
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) return { kind: "invalid", message: `"${token}" is not a number or a range like 2-5.` };
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start > end) return { kind: "invalid", message: `"${token}" is backwards — did you mean ${end}-${start}?` };
    if (start < 1 || end > findings.length) {
      return { kind: "invalid", message: `${token} is out of range — pick between 1 and ${findings.length}.` };
    }
    for (let n = start; n <= end; n++) picked.add(n - 1);
  }
  if (picked.size === 0) return { kind: "cancel" };
  return { kind: "picked", indices: [...picked].sort((a, b) => a - b) };
}

export interface InteractiveOptions {
  /** Findings in the order they were shown; the user picks them by 1-based position. */
  findings: Finding[];
  /** The scanned root. Nothing outside it is ever deleted. */
  root: string;
  /** Really delete (after typed confirmation). When false this is a dry run. */
  delete: boolean;
  ask: Ask;
  print: Print;
}

export interface InteractiveResult {
  outcome: "cancelled" | "invalid" | "dry-run" | "deleted";
  selected: Finding[];
  /** One entry per selected folder; only populated when deletion actually ran. */
  results: RemovalResult[];
}

/** Let the user pick findings, then preview (dry run) or delete them. */
export async function runInteractive(options: InteractiveOptions): Promise<InteractiveResult> {
  const { findings, root, ask, print } = options;
  const nothingDeleted = (outcome: "cancelled" | "invalid", message: string): InteractiveResult => {
    print(c.gray(`  ${message} Nothing was deleted.`));
    return { outcome, selected: [], results: [] };
  };

  if (findings.length === 0) return nothingDeleted("cancelled", "There is nothing to select.");

  // ── 1. Selection ─────────────────────────────────────────────────────────
  const selection = await askForSelection(options);
  if (selection === undefined) return nothingDeleted("invalid", "Too many invalid answers.");
  if (selection.kind === "cancel") return nothingDeleted("cancelled", "Cancelled.");

  const selected = selection.indices.flatMap((i) => findings[i] ?? []);

  // ── 2. Preview, with every safety check run up front ─────────────────────
  const problems = await Promise.all(selected.map((f) => checkRemovable(f, root)));
  const removable = selected.filter((_, i) => problems[i] === undefined);
  const removableSize = sumSize(removable);
  const mediumCount = removable.filter((f) => f.confidence === "medium").length;

  print();
  print(`  ${c.bold(`Selected ${plural(selected.length, "folder")}`)} ${c.gray("·")} ${c.bold(humanSize(sumSize(selected)))}`);
  const rows = selected.map((f, i) => {
    const problem = problems[i];
    const note =
      problem !== undefined
        ? c.red(`will be skipped: ${problem}`)
        : f.confidence === "medium"
          ? c.yellow("medium confidence")
          : "";
    return [colorForSize(f.size, humanSize(f.size).padStart(9)), prettyPath(f.path, root), note];
  });
  const hasNotes = rows.some((row) => row[2] !== "");
  print(
    indent(
      table(
        ["SIZE", "PATH", ...(hasNotes ? ["NOTE"] : [])],
        rows.map((row) => (hasNotes ? row : row.slice(0, 2))),
        ["right", "left", "left"],
      ),
    ),
  );
  print();

  if (mediumCount > 0) {
    print(c.yellow(`  ⚠ ${plural(mediumCount, "medium-confidence folder")} selected — make sure nothing hand-written lives there.`));
  }

  if (!options.delete) {
    print(`  ${c.cyan("Dry run")} — nothing was deleted. Deleting these would free ${c.bold(humanSize(removableSize))}.`);
    print(c.gray(`  Re-run with ${c.cyan("--delete")} to remove them for real.`));
    return { outcome: "dry-run", selected, results: [] };
  }

  if (removable.length === 0) {
    return nothingDeleted("cancelled", "Every selected folder would be skipped.");
  }

  // ── 3. Explicit confirmation ─────────────────────────────────────────────
  const confirm = await ask(
    `  ${c.red(`Permanently delete ${plural(removable.length, "folder")} (${humanSize(removableSize)})?`)} ` +
      `This cannot be undone. Type ${c.bold(`"${CONFIRM_WORD}"`)} to confirm: `,
  );
  if (confirm === null || confirm.trim().toLowerCase() !== CONFIRM_WORD) {
    return nothingDeleted("cancelled", "Cancelled.");
  }

  // ── 4. Delete, one folder at a time, re-checking each right before removal ─
  print();
  const results: RemovalResult[] = [];
  for (const [i, finding] of selected.entries()) {
    const problem = problems[i];
    const result: RemovalResult =
      problem !== undefined ? { finding, status: "skipped", reason: problem } : await removeArtifact(finding, root);
    results.push(result);
    print(`  ${describeResult(result, root)}`);
  }

  const removed = results.filter((r) => r.status === "removed");
  const notRemoved = results.length - removed.length;
  print();
  print(
    `  ${c.green("Freed")} ${c.bold(humanSize(sumSize(removed.map((r) => r.finding))))} ` +
      c.gray(`across ${plural(removed.length, "folder")}`) +
      (notRemoved > 0 ? c.yellow(` · ${notRemoved} not removed`) : ""),
  );
  return { outcome: "deleted", selected, results };
}

/** Ask until the answer parses; `undefined` after MAX_SELECTION_ATTEMPTS invalid answers. */
async function askForSelection(
  options: InteractiveOptions,
): Promise<Exclude<Selection, { kind: "invalid" }> | undefined> {
  const verb = options.delete ? "delete" : "preview";
  const question = `  Select folders to ${verb} ${c.gray("(e.g. 1,3,5-7 · all · high · Enter to cancel)")}: `;
  for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt++) {
    const answer = await options.ask(question);
    if (answer === null) return { kind: "cancel" };
    const parsed = parseSelection(answer, options.findings);
    if (parsed.kind !== "invalid") return parsed;
    options.print(c.red(`  ${parsed.message}`));
  }
  return undefined;
}

function describeResult(result: RemovalResult, root: string): string {
  const path = prettyPath(result.finding.path, root);
  switch (result.status) {
    case "removed":
      return `${c.green("✓ removed")}  ${path} ${c.gray(`(${humanSize(result.finding.size)})`)}`;
    case "skipped":
      return `${c.yellow("– skipped")}  ${path} ${c.gray(`— ${result.reason ?? "unsafe"}`)}`;
    case "failed":
      return `${c.red("✗ failed ")}  ${path} ${c.gray(`— ${result.reason ?? "unknown error"}`)}`;
  }
}

function sumSize(findings: readonly Finding[]): number {
  return findings.reduce((acc, f) => acc + f.size, 0);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
