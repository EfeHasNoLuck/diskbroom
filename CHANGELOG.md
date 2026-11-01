# Changelog

All notable changes to diskbroom are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-01

### Added

- **Interactive cleanup.** `-i` / `--interactive` numbers the results and lets
  you pick folders by number, range (`1,3,5-7`), `all` or `high`. It is a dry
  run by default; `--delete` (accepted only together with `-i`) deletes the
  picked folders after you type `yes`.
  ([#1](https://github.com/EfeHasNoLuck/diskbroom/pull/1))
- Every folder is re-checked right before it is deleted. It must still be
  inside the scanned path, not be (or sit behind) a symlink or junction, not be
  inside a protected folder or installed software, still match its rule, and
  contain no git-tracked files.
  ([#1](https://github.com/EfeHasNoLuck/diskbroom/pull/1))
- Scan several paths in one run: `diskbroom ~/code ~/work`. `--json` adds
  `roots`, and each finding carries the `root` it was found under.
  ([#15](https://github.com/EfeHasNoLuck/diskbroom/pull/15))
- Unreadable paths are reported instead of silently skipped. A warning says
  totals may be incomplete, `--verbose` lists the paths with their error codes,
  and `--json` adds `errorCount` and `errors`. Thanks to
  [imshah-id](https://github.com/imshah-id) for their first contribution!
  ([#13](https://github.com/EfeHasNoLuck/diskbroom/pull/13))

### Changed

- Stricter detection, so deletion is never offered for folders that belong to
  installed tools. `node_modules` and `coverage` now need a `package.json` or
  `deno.json` next to them, and `.gradle` needs a Gradle build or settings
  file. The scanner never descends into `node_modules`, `site-packages`,
  `dist-packages`, `.cache`, `.gradle`, macOS app bundles, Electron apps'
  `resources/app`, or editor extension folders (`.vscode`, `.cursor`, …).
  ([#1](https://github.com/EfeHasNoLuck/diskbroom/pull/1))

### Removed

- Support for Node.js 18 and 20, which are end-of-life. diskbroom now requires
  Node.js 22 or newer and is tested on 22, 24 and 26.
  ([#14](https://github.com/EfeHasNoLuck/diskbroom/pull/14))

### Fixed

- Extra path arguments were silently ignored, so `diskbroom ~/a ~/b` could
  report "nothing found" without ever scanning `~/b`.
  ([#15](https://github.com/EfeHasNoLuck/diskbroom/pull/15))

## [0.1.0] - 2026-07-10

### Added

- First release: a cross-ecosystem scanner for regenerable build artifacts
  (JavaScript, Python, Rust, Gradle, .NET, Terraform and generic build output),
  with confidence levels, `--top`, `--depth` and `--json`.

[Unreleased]: https://github.com/EfeHasNoLuck/diskbroom/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/EfeHasNoLuck/diskbroom/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EfeHasNoLuck/diskbroom/releases/tag/v0.1.0
