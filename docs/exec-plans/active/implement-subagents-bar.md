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
- Adopt the accepted public-protocol design. Atelier has no visibility acknowledgement/width API; never inspect its config. Identity-rich records are rendered instead of opaque fleet rows; unjoinable fleet-only metadata is deliberately unavailable, with separate non-additive provider counts. Optional cost enrichment only at lifecycle boundaries over unique explicit IDs.

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
- [x] Installed contracts and reference evidence complete: Pi 1.5.2, Atelier 0.18.0, pi-subagents 0.88.0; public v1 protocols, profile cycler 1.2.0/subscription panel 1.0.0 inspected read-only.
- [x] Technical design recorded in docs/design-docs/subagents-bar.md. Identity-rich async/foreground mode avoids uncorrelatable fleet duplicates; fleet counts remain separate. API limitations are explicit.
- [x] Sidebar increment validated and committed: public v1 publisher, safe rows/overflow, summary commands; 28 focused tests and strict typecheck passed.
- [x] Background monitor validated and committed: public ping/status + events, rich async snapshots, separate fleet counts, coalescing/timeouts/session guards, conservative stale/terminal state and 100-entry nonactive retention. No accumulated active cap.
- [x] Core foreground/tool-result history validated and committed: explicit indexed identity, promotion, child metrics, async representation suppression, current branch rebuild and RPC-independent coverage (66 focused tests).
- [ ] Structured notices, cross-source completion reconciliation and optional usage/elapsed enrichment complete.
- [ ] Independent review and corrections complete.
- [ ] Compatibility smoke, docs reconciliation and plan closure complete.

## Validation log

Not yet implemented. No tests run at baseline (npm test is a placeholder).

2026-11-12: first implementer run `fbed6326-8979-448b-a779-fc747f8ec114` failed upstream with HTTP 429 (Claude account rate limit). Inspected retained run and confirmed a clean worktree with empty src/tests. One bounded same-route recovery (`6a6b1f07-7772-4929-94b4-c93297a6b1b2`, claude-code/claude-sonnet-5-5, medium) failed identically; terminal failure verified. No partial implementation or test evidence exists. Stop retries; retain diagnostics in native run artifacts. Await explicit authorization for an alternative model route or provider recovery; do not silently fall back. Independent read-only smoke-feasibility explorer remains active (`45a28958-4fe8-443d-973f-d1cb902d72f8`).

2026-11-12: User explicitly reported Claude quota reset and authorized same-model recovery. Run `e89beacf-d494-40b2-b78a-97f941a776d2` completed the sidebar increment. Parent independently ran `npm run typecheck` and `npm run test:sidebar`: 28 tests passed. `git diff --check` passed. No provider/interactive smoke claimed. The initial panel honestly reports monitor integration pending. Smoke feasibility explorer completed; its recipe is advisory and must be checked against actual exported APIs before use.

2026-11-12: Background increment completed by `d958b7c7-e562-4040-972d-f624527105e4`. Parent identified and rejected an accumulated 1000-active safety cap as violating FR-03/08. Correction run `6b221ca8-2f48-434d-93c9-f0d518ebfe31` removed it and added a 1200-active retention regression. Parent ran `npm run typecheck`, `npm run test:monitor` (32 tests), `npm run test:sidebar` (28 tests), and `git diff --check`, all passed. Implementer initially used an unfocused 59-test run; subsequent validation uses explicit relevant files/scripts. Foreground/history remains explicitly pending in the display.

First-increment reviewer `95701940-4e1d-4f44-999b-442cf11e8983` encountered an Antigravity tool bridge warning (`bash`, no active streaming turn). Parent inspected native run state and instructed it not to bypass missing tool grants/alternate CLI or treat failed evidence as review success; final review still pending.

Smoke feasibility corrections: SDK root does not export `loadExtensionFromFactory`; use public `discoverAndLoadExtensions`. `ModelRegistry` requires a ModelRuntime. Do not trust suggested `PI_OFFLINE` as a credential/network isolation guarantee for subscription panel; its TUI startup reads credential contexts. Smoke must isolate environment and skip credential-bearing startup or use justified injected public seams.

2026-11-12: Isolated smoke implementation corrected after parent rejected permissive checks that hid simulated Atelier errors. Final scope is real SDK loader/runner + public RPC + real Atelier registry validator, NOT Atelier's live UI. Both load orders passed 25 checks per specialist. Parent independently reproduced bar-first (25/25) after fixing independent pi-tui resolution with an explicit host alias. Script is integrated at scripts/provider-smoke.mjs; final code will be rechecked. Subscription lifecycle is deliberately skipped to avoid credentials/polling; only registration coexistence is covered. No network/model/spawn work occurred.

2026-11-12: Foreground/history run b9a4b35d-fe6b-4552-b696-d1bace2ff6c1 spent ~29 minutes on analysis/drafts then failed with upstream Claude 429. Native terminal failure and clean Git tree confirmed; no implementation changes or test evidence from that run. Parent narrowed scope before failure; scratch /tmp/new_mid.ts is diagnostic only, not accepted code. User explicitly authorized all continuing implementer work on openai/gpt-6.1-terra:high. Continue fresh bounded increments: foreground tool records and branch history first; then notices/cross-source reconciliation and optional metrics/timing.

2026-11-12: Fresh Terra-high implementer d0fc886f-6723-45e4-91a9-308d0e51afc2 completed core foreground and current-branch toolResult history with localized changes. Parent inspected source and independently ran typecheck, four explicit focused Vitest files (66 tests passed), and diff --check. Notices/cost/elapsed refresh remain deliberately marked pending. Same-session late events for previously unseen tool IDs after branch navigation cannot be perfectly attributed using the untagged public event alone; document rather than invent correlation.

## Outcome

In progress; sidebar/background monitor and foreground/toolResult history complete, headless protocol smoke verified on ca67a89. User-authorized implementer route remains openai/gpt-6.1-terra:high. Structured notices, optional metrics/timing, final smoke, README and independent review remain.
