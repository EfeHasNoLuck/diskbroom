export type Confidence = "high" | "medium";

/**
 * A rule describing a directory that is safe to delete because a tool can
 * regenerate it (dependencies, build output, caches).
 */
export interface ArtifactRule {
  /** Directory base name to match (compared case-insensitively). */
  name: string;
  /** Human-friendly ecosystem label, e.g. "JavaScript". */
  ecosystem: string;
  /**
   * "high"  — unambiguous, always regenerable (headline total).
   * "medium" — the name is ambiguous (could hold source), so we only count it
   *            when a project marker sits next to it, and report it separately.
   */
  confidence: Confidence;
  /** Command that regenerates the folder, shown as a hint. */
  regenerate?: string;
  /** Only match when one of these files exists in the SAME parent directory. */
  requiresSibling?: string[];
  /** Only match when this file exists INSIDE the candidate directory. */
  requiresInner?: string;
}

/**
 * The known-artifact catalogue. Kept deliberately conservative: anything whose
 * name might contain real source code is "medium" and gated behind a sibling
 * project marker so we never flag a hand-written `build/` or `bin/` folder.
 */
export const RULES: ArtifactRule[] = [
  // ── JavaScript / TypeScript ───────────────────────────────────────────────
  { name: "node_modules", ecosystem: "JavaScript", confidence: "high", regenerate: "npm install" },
  { name: ".next", ecosystem: "JavaScript", confidence: "high", regenerate: "next build" },
  { name: ".nuxt", ecosystem: "JavaScript", confidence: "high", regenerate: "nuxt build" },
  { name: ".svelte-kit", ecosystem: "JavaScript", confidence: "high", regenerate: "vite build" },
  { name: ".turbo", ecosystem: "JavaScript", confidence: "high" },
  { name: ".parcel-cache", ecosystem: "JavaScript", confidence: "high" },
  { name: ".angular", ecosystem: "JavaScript", confidence: "high" },
  { name: "coverage", ecosystem: "JavaScript", confidence: "medium", regenerate: "re-run tests" },

  // ── Python ────────────────────────────────────────────────────────────────
  { name: "__pycache__", ecosystem: "Python", confidence: "high" },
  { name: ".venv", ecosystem: "Python", confidence: "high", regenerate: "python -m venv .venv" },
  { name: "venv", ecosystem: "Python", confidence: "high", requiresInner: "pyvenv.cfg", regenerate: "python -m venv venv" },
  { name: ".mypy_cache", ecosystem: "Python", confidence: "high" },
  { name: ".pytest_cache", ecosystem: "Python", confidence: "high" },
  { name: ".ruff_cache", ecosystem: "Python", confidence: "high" },
  { name: ".tox", ecosystem: "Python", confidence: "high" },

  // ── Rust ──────────────────────────────────────────────────────────────────
  { name: "target", ecosystem: "Rust", confidence: "high", requiresSibling: ["Cargo.toml"], regenerate: "cargo build" },

  // ── Java / Kotlin / Gradle ────────────────────────────────────────────────
  { name: ".gradle", ecosystem: "Gradle", confidence: "high" },

  // ── .NET ──────────────────────────────────────────────────────────────────
  { name: "bin", ecosystem: ".NET", confidence: "medium", requiresSibling: ["*.csproj", "*.fsproj", "*.vbproj", "*.sln"] },
  { name: "obj", ecosystem: ".NET", confidence: "medium", requiresSibling: ["*.csproj", "*.fsproj", "*.vbproj", "*.sln"] },

  // ── Generic build output (ambiguous name → require a project marker) ───────
  { name: "dist", ecosystem: "Build output", confidence: "medium", requiresSibling: ["package.json", "Cargo.toml", "pyproject.toml", "setup.py"] },
  { name: "build", ecosystem: "Build output", confidence: "medium", requiresSibling: ["package.json", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "pyproject.toml"] },

  // ── Infra ─────────────────────────────────────────────────────────────────
  { name: ".terraform", ecosystem: "Terraform", confidence: "high", regenerate: "terraform init" },
];
