# diskbroom

> Find and reclaim the gigabytes of regenerable build junk rotting across all your projects — safely, on any OS.

[![npm](https://img.shields.io/npm/v/diskbroom.svg)](https://www.npmjs.com/package/diskbroom)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Every developer's disk is quietly bleeding space to `node_modules`, `.venv`,
`target/`, `.gradle`, and a dozen build caches — all of it perfectly
regenerable with a single command. **diskbroom** walks your projects, adds it
all up, shows you exactly where the space went, and — only if you ask — lets
you pick folders to delete.

<p align="center">
  <img src="https://raw.githubusercontent.com/EfeHasNoLuck/diskbroom/main/.github/demo.svg" alt="diskbroom scanning ~/code and reporting 3.6 GB of reclaimable build artifacts across JavaScript, Rust, Python and Gradle projects" width="760">
</p>

## Why another cleaner?

Most tools only know about `node_modules` and lean Unix-only. diskbroom is:

- **Cross-ecosystem** — JavaScript, Python, Rust, Java/Gradle, .NET, Terraform, and more in one pass.
- **First-class on Windows** — built and tested on Windows, macOS, and Linux.
- **Safe by design** — never follows symlinks, never descends into system folders, installed software or tool caches, and **never deletes anything unless you explicitly ask**. By default it only reports; deleting needs `--interactive --delete`, your own selection, and a typed `yes`.
- **Precise** — ambiguous names like `target/`, `dist/`, and `bin/` are only flagged when a real project marker (e.g. `Cargo.toml`, `package.json`, a `.csproj`) sits next to them, so your hand-written `build/` folder is left alone.
- **Zero runtime dependencies** — small, fast, and nothing sketchy in your `node_modules` (ironic, we know).

## Install

Run it once without installing:

```bash
npx diskbroom
```

Or install globally:

```bash
npm install -g diskbroom
```

## Usage

```bash
diskbroom [path...] [options]
```

| Option | Description |
| --- | --- |
| `path...` | One or more directories to scan (default: current directory) |
| `-i, --interactive` | Pick folders from the results to remove — a dry run unless `--delete` is also given |
| `--delete` | With `-i`: really delete the picked folders, after you type `yes` to confirm |
| `--top <n>` | Show only the *n* largest findings |
| `--depth <n>` | Limit how deep to descend |
| `--json` | Output machine-readable JSON |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Examples

```bash
diskbroom                     # scan the current folder
diskbroom ~/code --top 20     # 20 biggest artifacts under ~/code
diskbroom ~/code ~/work       # scan several folders in one go
diskbroom . --json            # JSON output for scripts or CI
diskbroom ~/code -i           # pick folders, preview the space you'd free (dry run)
diskbroom ~/code -i --delete  # pick folders, confirm, then delete them
```

### Interactive cleanup

With `-i`, diskbroom numbers the results and asks which ones you want gone:

```text
  #       SIZE  ECOSYSTEM     CONFIDENCE  PATH
  1     1.2 GB  JavaScript    high        webapp/node_modules
  2     840 MB  Rust          high        cli/target
  3    41.0 MB  Build output  medium      site/dist

  Select folders to delete (e.g. 1,3,5-7 · all · high · Enter to cancel): 1-2
```

- Pick with numbers and ranges (`1,3,5-7`), `all`, or `high` for every
  high-confidence folder. Press Enter to cancel. With `--top`, the numbers
  refer to the rows shown.
- **Without `--delete` it is a dry run**: you see exactly which folders would
  go and how much space you'd get back, and nothing is touched.
- **With `--delete`** diskbroom asks you to type `yes` (a bare `y` won't do).
  Any other answer, Ctrl+C, or end of input cancels. Deletion is permanent —
  folders are not moved to the Trash — so everything must be regenerable,
  which is exactly what diskbroom looks for.

Right before each folder is deleted, diskbroom checks it again. It is skipped
(and reported) if it is no longer inside the scanned path, if it or any folder
above it has turned into a symlink or junction, if it sits inside a protected
system or VCS folder or inside installed software, if it no longer matches its rule
(say, the `Cargo.toml` next to `target/` is gone), or if git tracks files inside
it (like a GitHub Action's committed `dist/`; checked whenever git is
installed). Symlinks *inside* a deleted folder are removed as links; whatever
they point to is never touched.

## What it detects

| Ecosystem | Folders |
| --- | --- |
| JavaScript | `node_modules` and `coverage` (next to a `package.json` or `deno.json`), `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.angular` |
| Python | `.venv`, `venv`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| Rust | `target` (next to a `Cargo.toml`) |
| Java / Gradle | `.gradle` (next to a Gradle build or settings file) |
| .NET | `bin`, `obj` (next to a project/solution file) |
| Build output | `dist`, `build` (next to a project manifest) |
| Terraform | `.terraform` |

diskbroom never looks inside installed software or caches: `site-packages`,
Node's global `lib/node_modules`, `~/.cache`, the Gradle user home `~/.gradle`,
macOS `.app` bundles, Electron apps' packaged `resources/app`, or editor
extensions (`~/.vscode/extensions`, `~/.vscode-server`, `~/.cursor`). Anything
in there belongs to an installed tool, not to your projects, and reinstalling
dependencies won't bring it back.

Missing something? [Open an issue](https://github.com/EfeHasNoLuck/diskbroom/issues) — the catalogue is easy to extend in [`src/patterns.ts`](./src/patterns.ts).

## Confidence levels

- **high** — the folder is unambiguous and always regenerable. Counted in the headline total.
- **medium** — the folder *name* could theoretically hold source, so diskbroom only flags it when a project marker is present, and reports it separately for you to review.

## Roadmap

- [x] Interactive mode — select folders and delete them (dry-run by default, `--delete` + typed confirmation)
- [ ] `--older-than 30d` to target only stale artifacts
- [ ] Config file for custom rules and ignore paths
- [ ] Package-manager cache cleanup (npm, pip, cargo, Gradle global caches)

## Contributing

Issues and PRs are very welcome — especially new ecosystem rules. See
[`src/patterns.ts`](./src/patterns.ts) for how detection works.

```bash
git clone https://github.com/EfeHasNoLuck/diskbroom
cd diskbroom
npm install
npm test
npm run build
node dist/cli.js --help
```

## License

[MIT](./LICENSE) © Efe Saygılı
