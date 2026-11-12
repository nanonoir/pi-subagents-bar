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
- [ ] Sidebar increment validated and committed.
- [ ] Background monitor validated and committed.
- [ ] Foreground/history validated and committed.
- [ ] Independent review and corrections complete.
- [ ] Compatibility smoke, docs reconciliation and plan closure complete.

## Validation log

Not yet implemented. No tests run at baseline (npm test is a placeholder).

2026-11-12: first implementer run `fbed6326-8979-448b-a779-fc747f8ec114` failed upstream with HTTP 429 (Claude account rate limit). Inspected retained run and confirmed a clean worktree with empty src/tests. One bounded same-route recovery (`6a6b1f07-7772-4929-94b4-c93297a6b1b2`, claude-code/claude-sonnet-5-5, medium) failed identically; terminal failure verified. No partial implementation or test evidence exists. Stop retries; retain diagnostics in native run artifacts. Await explicit authorization for an alternative model route or provider recovery; do not silently fall back. Independent read-only smoke-feasibility explorer remains active (`45a28958-4fe8-443d-973f-d1cb902d72f8`).

## Outcome

Blocked before implementation by repeated upstream Claude account rate limiting. Exploration/spec registration/design are complete; all functional increments, tests, installed-provider smoke, README and final review remain pending.
