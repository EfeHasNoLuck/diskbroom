// Tiny, dependency-free ANSI colouring + table helpers.

const useColor =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

function paint(code: number): (s: string) => string {
  return (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
  gray: paint(90),
};

const UNITS = ["KB", "MB", "GB", "TB", "PB"];

/** Format a byte count as a short human-readable string (base 1024). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = UNITS[unitIndex] ?? "PB";
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

/** Colour a size string by magnitude: red ≥1 GB, yellow ≥100 MB, else dim. */
export function colorForSize(bytes: number, text: string): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (bytes >= GB) return c.bold(c.red(text));
  if (bytes >= 100 * MB) return c.yellow(text);
  return c.dim(text);
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Length of a string ignoring ANSI colour codes. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, "").length;
}

type Align = "left" | "right";

/** Render a simple aligned text table (ANSI-aware column widths). */
export function table(headers: string[], rows: string[][], aligns: Align[] = []): string {
  const widths = headers.map((header, col) => {
    let width = visibleLength(header);
    for (const row of rows) width = Math.max(width, visibleLength(row[col] ?? ""));
    return width;
  });

  const pad = (text: string, width: number, align: Align): string => {
    const spaces = " ".repeat(Math.max(0, width - visibleLength(text)));
    return align === "right" ? spaces + text : text + spaces;
  };

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, col) => pad(cell, widths[col] ?? 0, aligns[col] ?? "left"))
      .join("  ")
      .trimEnd();

  const lines = [renderRow(headers.map((h) => c.gray(h)))];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join("\n");
}
