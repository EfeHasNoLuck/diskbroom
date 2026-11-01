# diskbroom

> Find and reclaim the gigabytes of regenerable build junk rotting across all your projects — safely, on any OS.

[![npm](https://img.shields.io/npm/v/diskbroom.svg)](https://www.npmjs.com/package/diskbroom)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Every developer's disk is quietly bleeding space to `node_modules`, `.venv`,
`target/`, `.gradle`, and a dozen build caches — all of it perfectly
regenerable with a single command. **diskbroom** walks your projects, adds it
all up, and shows you exactly where the space went.

<p align="center">
  <img src="https://raw.githubusercontent.com/EfeHasNoLuck/diskbroom/main/.github/demo.svg" alt="diskbroom scanning ~/code and reporting 3.6 GB of reclaimable build artifacts across JavaScript, Rust, Python and Gradle projects" width="760">
</p>

## Why another cleaner?

Most tools only know about `node_modules` and lean Unix-only. diskbroom is:

- **Cross-ecosystem** — JavaScript, Python, Rust, Java/Gradle, .NET, Terraform, and more in one pass.
- **First-class on Windows** — built and tested on Windows, macOS, and Linux.
- **Safe by design** — never follows symlinks, never descends into system folders, and (for now) **never deletes anything**. It only reports.
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
diskbroom [path] [options]
```

| Option | Description |
| --- | --- |
| `path` | Directory to scan (default: current directory) |
| `--top <n>` | Show only the *n* largest findings |
| `--depth <n>` | Limit how deep to descend |
| `--json` | Output machine-readable JSON |
| `--verbose` | List unreadable paths and their filesystem error codes |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

### Examples

```bash
diskbroom                     # scan the current folder
diskbroom ~/code --top 20     # 20 biggest artifacts under ~/code
diskbroom . --json            # JSON output for scripts or CI
```

If a directory cannot be listed or a file cannot be measured, the scan continues
and warns that totals may be incomplete. Use `--verbose` for the affected paths
and error codes (for example, `EACCES` or `ENOENT`). JSON output includes
`errorCount` and an `errors` array of `{ path, code }` entries alongside `findings`.
Each affected path is reported once, even if it was checked more than once.

## What it detects

| Ecosystem | Folders |
| --- | --- |
| JavaScript | `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.angular`, `coverage` |
| Python | `.venv`, `venv`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| Rust | `target` (next to a `Cargo.toml`) |
| Java / Gradle | `.gradle` |
| .NET | `bin`, `obj` (next to a project/solution file) |
| Build output | `dist`, `build` (next to a project manifest) |
| Terraform | `.terraform` |

Missing something? [Open an issue](https://github.com/EfeHasNoLuck/diskbroom/issues) — the catalogue is easy to extend in [`src/patterns.ts`](./src/patterns.ts).

## Confidence levels

- **high** — the folder is unambiguous and always regenerable. Counted in the headline total.
- **medium** — the folder *name* could theoretically hold source, so diskbroom only flags it when a project marker is present, and reports it separately for you to review.

## Roadmap

- [ ] Interactive mode — select folders and delete them (dry-run by default, with confirmation)
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
