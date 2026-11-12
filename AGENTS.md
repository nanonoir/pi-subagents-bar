# Repository guide

`pi-subagents-bar` is a private Pi package described in its manifest as live subagent monitoring for Pi Atelier. The repository currently contains package scaffolding, not an implemented extension.

## Operational stack

- ECMAScript modules; the Pi extension entry configured in `package.json` is TypeScript.
- Pi coding agent development dependency: `@earendil-works/pi-coding-agent` ^1.5.2 (lockfile: 1.5.2). TypeScript ^7.0.2, Vitest ^5.1.0 and Node types ^26.6.6 are development dependencies; exact resolved versions are in `package-lock.json`.
- npm lockfile version 3. No runtime version, UI framework, styling system, database, ORM, or configured build, lint, format or type-check tool is specified in the repository.

## Map and sources of truth

- `package.json` and `package-lock.json`: package metadata, dependencies and scripts; the manifest configures `src/index.ts` as a Pi extension entry, but that file does not yet exist.
- `src/` and `tests/` currently contain no files. Empty directories are not tracked by Git.
- [Architecture](ARCHITECTURE.md) describes the current structure; [product specs](docs/product-specs/index.md) and [design decisions](docs/design-docs/index.md) catalog authoritative documents when available.
- [Plan conventions](docs/PLANS.md) and the [debt tracker](docs/exec-plans/tech-debt-tracker.md) cover execution records and concrete unresolved debt.

## Commands

- `npm install` installs dependencies according to npm's manifest and lockfile behavior; `npm ci` installs from the lockfile.
- `npm test` currently runs a placeholder that exits with an error; it is not a working test suite. No other scripts are configured.

Do not treat existing implementation or scaffolding as a product specification. Check the manifest and configuration when operational details change.
