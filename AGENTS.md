# Repository guide

`pi-subagents-bar` is a private Pi package providing a read-only **Subagents** panel for the Pi Atelier sidebar. It observes foreground and background executions from `nicobailon/pi-subagents` via public RPC and bus events without mutating state, spawning subagents, or polling.

## Operational stack

- ECMAScript modules; Pi extension entry configured in `package.json` is TypeScript (`src/index.ts`).
- Runtime: Node.js >=22.19.0 (`engines.node` in `package.json`).
- Host SDK: `@earendil-works/pi-coding-agent` ^1.5.2 as a development dependency and `*` as a host-supplied peer.
- Dev dependencies: TypeScript ^7.0.2, Vitest ^5.1.0, Node types ^26.6.6. Exact resolved versions are in `package-lock.json`.
- Zero runtime dependencies; private package (`"private": true`). No build step required (TypeScript executed directly by Pi extension runner).

## Map and sources of truth

- `package.json` and `package-lock.json`: package metadata, dependencies, and test/typecheck scripts; entry point is `src/index.ts`.
- `src/`: extension implementation:
  - `src/index.ts`: extension lifecycle entry point, Pi hooks, `/subagents-bar` command handler.
  - `src/monitor.ts`: public RPC client, capability negotiation, event handling, normalized records, identity reconciliation, retention.
  - `src/atelier.ts`: Atelier sidebar panels protocol v1 publisher, row rendering, code point and row budgeting.
  - `src/types.ts`: shared contracts and snapshot interfaces between monitor and renderer.
- `tests/`: focused Vitest test suites (`atelier.test.ts`, `cost.test.ts`, `foreground.test.ts`, `index.test.ts`, `monitor.test.ts`, `notices.test.ts`).
- `scripts/`: `scripts/provider-smoke.mjs` for isolated headless protocol smoke with real SDK and Atelier registry.
- [Architecture](ARCHITECTURE.md) describes the component structure, data flow, and runtime boundaries.
- [Product specs](docs/product-specs/index.md) (`docs/pi-subagents-bar.md`) is the canonical product requirements authority.
- [Design decisions](docs/design-docs/index.md) (`docs/design-docs/subagents-bar.md`) records technical choices, public protocol integration, and identity rules.
- [Plan conventions](docs/PLANS.md) and the [debt tracker](docs/exec-plans/tech-debt-tracker.md) cover execution records and concrete unresolved debt.
- [Interactive manual smoke](docs/manual-smoke.md) provides the visual acceptance checklist for the user.

## Commands

- `npm ci`: install exact lockfile dependencies.
- `npm test`: run all Vitest test suites.
- `npm run typecheck`: run strict typecheck (`tsc --noEmit -p tsconfig.json`).
- `npm run test:monitor`: run monitor tests.
- `npm run test:foreground`: run foreground child reconciliation tests.
- `npm run test:notices`: run notice and elapsed refresh tests.
- `npm run test:cost`: run terminal cost enrichment tests.
- `npm run test:index`: run command and extension entry tests.
- `npm run test:renderer`: run Atelier sidebar renderer tests.
- `npm run test:sidebar`: run combined sidebar and index tests.
- `npm run test:providers`: run isolated headless provider smoke test (`scripts/provider-smoke.mjs`).

Do not treat existing implementation as a product specification; `docs/pi-subagents-bar.md` is the canonical product authority. Check the manifest and configuration when operational details change.
