# Implement pi-subagents-bar

## Objective and authority

Deliver the approved [PRD](../../pi-subagents-bar.md) as a minimal, read-only Atelier sidebar extension. Preserve installed extensions and user configuration. User authorizes implementation, focused checks and small semantic local commits; no push, releases or publication.

## Baseline

2026-11-12: branch `main`, initial commit `14fb89f`; package/lockfile scaffolding only, empty src/tests. Existing untracked AGENTS.md, ARCHITECTURE.md and docs (including the supplied PRD and initialized harness) must be preserved and included deliberately. No remotes configured. Pi dev dependency is 1.5.2. No execplan/design/specs skills are exposed in the installed skill catalog; use docs/PLANS.md and existing designer/specs-writer specialist contracts, not invented skills.

## Stages and dependencies

1. **Contract evidence** — explorer checks installed Pi/Atelier/pi-subagents APIs, session identity, history, event shapes and references. Parent checks upstream monitoring examples. Specs writer registers the existing PRD, without duplicating it.
2. **Technical design** — designer records only meaningful decisions based on stage 1; resolve identity/reconciliation, lifecycle, retention and degradation before implementation.
3. **Sidebar increment** — implementer adds strict TS/check scripts, public Atelier protocol adapter, static diagnostic panel and visibility command, with focused tests. Parent validates and commits.
4. **Background monitor increment** — implementer integrates capability negotiation/status/events, explicit normalized records and rendering, burst coalescing/stale replies/teardown tests. Parent validates and commits.
5. **Foreground/history increment** — implementer completes structured tool/session record coverage and conservative reconciliation, session lifecycle and retention tests. Parent validates and commits.
6. **Acceptance and delivery** — fresh reviewer examines PRD compliance/engineering; fix-agent addresses accepted findings. Perform focused typecheck/tests and feasible installed-provider smoke; distinguish headless contracts from real interactive visual checks. Complete README/license/metadata, then archiver reconciles harness and closes plan. Parent commits local increments and delivers exact acceptance status.

Stages 3–5 may be repartitioned following design evidence, but each commit must be coherent and validated. One writer per workspace; parallelize independent read-only evidence/review only. Do not create PR branches/chains since delivery is local commits only.

## Decisions

- Product authority remains the supplied PRD at docs/pi-subagents-bar.md.
- Neutral/non-success category sorts after failed and before successful, with explicit status labels; no cancellation/unknown is called completed.
- Prefer summary-only collapse; never change Atelier layout/configuration.
- No runtime extension dependencies, LLM tools, prompts, agent spawns, polling, credentials/network/filesystem scans in shipped code.

## Risks and acceptance evidence

- Fleet keys are opaque; correlate only documented identifiers. Never infer run IDs from fleet keys or role/task similarity.
- Fleet is bounded and not history. Source gaps must be explicit; restore only current active branch session records.
- Session generation guards and cleanup must prevent stale state/listeners/timers across reload/switch.
- Provider load order and unavailable RPC must preserve honest state and never fake completion.
- Sanitize plain text, honor 24-row/length constraints, keep all reported active records internally, reserve overflow counts.
- Automated acceptance targets PRD UT-01–UT-12, public protocol envelopes and absence of mutating/context APIs.
- Installed-provider headless smoke can validate load/contract interoperability without model calls. Real terminal resize/display/profile/subscription interaction may remain manual if no interactive terminal is accessible; never claim it passed without evidence.

## Progress

- [x] Read PRD, repository guide, testing/git-delivery/TypeScript skills; inspected baseline Git state.
- [x] Specs writer registered PRD in product index.
- [ ] Installed contracts and reference evidence complete.
- [ ] Technical design recorded.
- [ ] Sidebar increment validated and committed.
- [ ] Background monitor validated and committed.
- [ ] Foreground/history validated and committed.
- [ ] Independent review and corrections complete.
- [ ] Compatibility smoke, docs reconciliation and plan closure complete.

## Validation log

Not yet implemented. No tests run at baseline (npm test is a placeholder).

## Outcome

In progress.
