# Product Requirements Document — pi-subagents-bar

**Version:** 1.0 (implementation handoff)  
**Date:** 2026-11-12  
**Status:** Approved scope / implementation pending  
**Package:** `pi-subagents-bar`  
**Target:** Pi interactive TUI with Pi Atelier and `nicobailon/pi-subagents`  
**Platform priority:** Windows 11 / PowerShell; avoid platform-specific assumptions

---

## 1. Executive summary

Build **pi-subagents-bar**, a small, read-only Pi extension that displays the subagents managed by **`nicobailon/pi-subagents`** in **Pi Atelier's existing sidebar**.

The user's currently working subagent monitor is the functional reference. Preserve its essential behavior: live status, a task title, agent role, model, elapsed execution time and token usage; active jobs first, failed jobs second, successful jobs last. Unlike the current under-editor widget, the new monitor must appear inside Atelier's sidebar and remain unobtrusive.

The plugin is **a viewer, not an orchestrator**. It must not spawn agents, replace their execution system, introduce LLM-callable tools, inject prompts, or install a second TUI/sidebar. It must coexist with the user's `pi-profile-cycler`, `pi-subscription-panel`, and Pi Atelier configuration.

**North star:** the same useful visibility as the existing monitor, in the right place, with almost zero configuration and no additional agent context.

## 2. Background and problem

The user has migrated a functioning OpenCode harness to Pi. Pi subagent execution is already verified. What remains is a UI ergonomics problem: a compact subagent display appears below the conversation/editor area, while the user prefers the always-available Atelier sidebar.

Atelier's public sidebar-panel protocol supports text rows and live updates, but **not interactive accordion rows**. Therefore, do not attempt to recreate clickable accordions or patch Atelier's internals. Expose a small Pi slash command for visibility instead.

### Existing behavior to preserve

- One record per actual subagent execution, including concurrent executions of the same role.
- Ordering: `running` (highest priority) → `error/failed` → `completed/success`.
- Task/title, agent type, model, duration and tokens when available.
- Live status changes without intrusive transcript output.
- A session-scoped history of finished executions, within reasonable display bounds.

### Out of scope

Rebuilding `pi-subagents`, alternate orchestration, a separate sidebar renderer, full FleetView/inspector controls, clickable accordion widgets, authentication, network services, telemetry, analytics, model/profile selection, subscription data, and changing agent prompts.

## 3. Goals and acceptance priorities

### P0 — Required

1. Render a `Subagents` panel using **Atelier's public sidebar-panel protocol v1** only.
2. Reflect live background subagent jobs from the installed **`nicobailon/pi-subagents`**, using its documented in-process RPC/events.
3. Capture and reconcile foreground executions from Pi's documented `subagent` tool progress/result events.
4. Display completed and failed runs from the current session where their records are available.
5. Preserve priority ordering: active first, errors second, completed last.
6. Show task/title, agent role, model, elapsed/final duration and token consumption **when actually available**; never invent missing metadata.
7. Support `/subagents-bar`, `/subagents-bar show`, `/subagents-bar hide`, and `/subagents-bar toggle` with explicit, tested behavior.
8. Do not break Atelier, `pi-profile-cycler`, `pi-subscription-panel`, or `pi-subagents`.
9. Contribute **zero additional LLM-callable tools, prompt instructions, model turns, or agent work**.
10. Load cleanly on Windows and across `/reload`, session switches, and extension load-order variations.

### P1 — Desirable if cheap

- Graceful restoration of retained current-session history after restarting/reopening Pi.
- Clean overflow counts when the panel exceeds Atelier row limits.
- Small active-only elapsed-time display refresh without RPC polling.
- Optional shortcut, only if the existing Pi/Atelier keymap allows it without collision; **not required for v1**.

### Non-goals for v1

- Interacting with agents (stop/steer/resume/open transcript).
- Filtering, searching, sorting UI menus, scrolling within the panel, or mouse support.
- Cross-session/global run search.
- Persisting a separate database or its own full execution history.
- Supporting arbitrary subagent extensions beyond `nicobailon/pi-subagents`.
- Running a separate orchestrator or replacing any Pi UI element.

## 4. Integration contracts: inspect before implementing

The implementation agent **must inspect the currently installed packages and their actual public contracts**, not assume the signatures in this PRD are exhaustive or copy internal implementation details from unrelated releases. Confirm versions with package metadata; do not blindly change existing packages.

### 4.1 Atelier producer integration

Primary references:

- https://github.com/michaelmjhhhh/pi-atelier
- https://github.com/michaelmjhhhh/pi-atelier/blob/main/src/sidebar-panels.ts

Use the public `pi-atelier:sidebar-panels` protocol v1 (direct event-bus producer or its documented helper, depending on what is safely resolvable from an independent Pi package). The documented helper exposes a lifecycle similar to:

```ts
const panel = registerSidebarPanel(pi, {
  id: "subagents-bar:subagents",
  title: "Subagents",
  rows: ["No subagents yet"],
});
panel.update({ id: "subagents-bar:subagents", title: "Subagents", rows: [...] });
panel.dispose();
```

**This snippet illustrates the public API; verify the import path and types before using it.** Prefer versioned EventBus integration rather than a runtime import of a separately installed package when its module path cannot be resolved reliably.

Requirements:

- Stable namespaced panel ID, e.g. `subagents-bar:subagents`.
- Compatible with either extension loading first.
- Plain text, semantic roles/colors, no raw ANSI escapes.
- Honor Atelier's actual panel limits and validation, including its documented **24-row ceiling**.
- Atelier controls sidebar placement and layout; do not override other panels.
- **New Atelier-contributed panels start hidden.** Include a clear first-run instruction to enable `Subagents` via `/atelier display` (or Atelier Settings → Display). Do not assume registration automatically makes it visible.
- Dispose/unregister listeners and panel cleanly during reload/shutdown and avoid duplicate registration.

### 4.2 Subagent data integration

Primary reference:

- https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md

Use the documented in-process **`subagents:rpc:v1:*`** request/reply interface. At initialization, subscribe to events before reading current status; query `ping` to detect capabilities, then perform the first `status` read. Do not read private module internals or scrape rendered slash-command output.

Relevant documented capabilities and events include:

- `ping.capabilities.fleetStatus` (version 1).
- `status` data with `fleet` and optionally `asyncSnapshot`.
- `subagent:jobs-changed`, and the other supported change signals listed by `ping.events`.
- Foreground `tool_execution_update` for the `subagent` tool.
- Session records: foreground `subagent` result `details.results[]`, background `subagent-notify` `details.runs[]`.
- Optional `cost` RPC for reconciled child usage, if needed.

**Important differences:**

- `fleet.entries` is a bounded active-display projection, not a complete historical or terminal execution log.
- Fleet `key` is **opaque** and must never be treated as a run ID.
- `asyncSnapshot.runs[].id` is a run ID, a different identity namespace.
- Foreground run children should be correlated using `(runId, index)` where available, not array index/position.
- A session history reconstruction cannot depend solely on `fleet`.
- Do not assume every live or final record includes model, tokens, goal, time or status. Missing values must degrade honestly.

When API capabilities are missing, do not silently claim full support. Report graceful `unavailable` or partial information, and document the minimum supported version determined by inspection.

### 4.3 Reference extensions — use ideas, not their runtimes

- `fan56/pi-sidebar-panel`: https://github.com/fan56/pi-sidebar-panel — study run tracking, deduplication, status ordering and bounded retention. **Do not copy its custom sidebar, overlays, or assumptions about a different `pi-subagents` implementation.**
- `saifymatteo/pi-orchestrator`: https://github.com/saifymatteo/pi-orchestrator — study its optional Atelier Fleet panel integration, load-order independence and compact text rendering. **Do not install or copy its workers, delegation tools, permission gating, or orchestration.**

Be mindful of license compatibility and attribution if any code is copied. Prefer an independent implementation based on public contracts.

## 5. Functional requirements

### FR-01: Single, compact sidebar panel

Atelier should display exactly one contributed panel titled `Subagents`. Do not create a custom footer, separate sidebar, overlay, inspector or under-editor widget.

Default expanded rendering should include a compact header/counter summary and a prioritized list. Render two lines per agent if space allows; a third line is permitted only if the final layout reliably fits. Preferred per-execution information:

```text
Subagents
2 run · 1 err · 3 done
● Implement authentication (implementer)
  Sonnet 5.5 · 01:42 · 18.2k tok
✕ Fix CI workflow (fix-agent)
  Terra · 00:41 · 3.9k tok
✓ Review changes (reviewer)
  Sol · 01:09 · 37.4k tok
```

This is **illustrative data**. Format must be responsive to the actual sidebar width, using safe Unicode-width truncation or existing supported helpers. Avoid long task text wrapping and crowding the next panel. Support Atelier's plain-text font mode; Unicode icons may be replaced with simple ASCII markers.

### FR-02: Status classification and ordering

- Active/running/queued executions first. Distinguish queued from running if the source exposes it.
- Failed/errored terminal executions second.
- Successful completed executions third.
- Paused, stopped, interrupted, cancelled, or unknown statuses must not be mislabeled `completed`. Define a clearly documented mapping and appropriate neutral or warning category for states beyond the three principal groups.
- Within a category, use deterministic ordering: newest relevant timestamp first, then stable identity tie-breaker.
- Do not show two rows for the same execution after reconciling live and terminal information.
- Keep active records visible as long as the provider reports them; lack of an event or temporarily stale time is **not** proof of completion.

### FR-03: Reliable identity, state and history

Implement a small, explicit normalized view model, for example:

```ts
type DisplayRun = {
  key: string;                // namespaced, stable for reconciliation
  status: "queued" | "running" | "failed" | "completed" | "stopped" | "paused" | "unknown";
  task?: string;
  agent?: string;
  model?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  tokens?: { input?: number; output?: number; total?: number };
  source: "fleet" | "async" | "foreground" | "session";
};
```

Treat this as an illustrative internal type, not an external API. Normalize validated source records with conservative fallbacks. Preserve source identifiers and timestamp precision where offered. If a live display key cannot safely be correlated to a historical completion record, do **not** invent a link or merge distinct executions. Document the limitation and keep the status honest.

Maintain a bounded in-memory view for the current Pi session. Reconstruct completed/failed entries from documented existing session data where feasible, rather than saving a second execution database. Clearly define the retention cap and overflow display. Never erase active entries to retain completed ones.

### FR-04: Event-driven updates

- Subscribe before initial status fetch, then refresh on relevant documented change events.
- Coalesce bursts (approximately 250 ms is a reasonable starting point); do not issue duplicate concurrent RPC status requests.
- If a change occurs during a pending request, schedule one additional refresh afterward; avoid stale replies overwriting newer state.
- Handle foreground `tool_execution_update` snapshots, tool completion, and background completion notices.
- No permanent status polling. A lightweight timer **only to update elapsed text while active jobs exist** is acceptable, if needed; it must not repeatedly fetch RPC status and must be cleaned up.
- Limit unnecessary redraws: update Atelier only when normalized display content changes or displayed time meaningfully advances.

### FR-05: Slash commands and visibility

Register a single Pi slash command: `subagents-bar`.

| Command | Expected behavior |
| --- | --- |
| `/subagents-bar` | Toggle the monitor's visible content |
| `/subagents-bar show` | Show the detailed agent list |
| `/subagents-bar hide` | Hide/collapse the detailed list |
| `/subagents-bar toggle` | Toggle between those modes |

**Visibility design decision (must be verified during implementation):** Atelier owns whether a contributed panel is enabled in the sidebar, while the extension owns the content it contributes. Prefer a **summary-only collapsed mode** when `hide` is invoked, because it retains counts and preserves Atelier's saved display layout. If Atelier exposes a documented way to truly hide and restore an individual contributed panel without losing the user's layout, full hide/show is acceptable instead. **Do not edit Atelier private state/files or repeatedly dispose/re-register if it makes the panel become disabled unexpectedly.**

Make command feedback precise: if Atelier's display layout has the panel disabled, `show` can expand the plugin state but must tell the user to enable the panel via `/atelier display`. Do not claim that `show` changed Atelier's panel enablement unless that was actually verified.

Unknown arguments must display concise usage. No interactive configuration wizard, no new hotkey required.

Visibility preference can be in-memory per Pi process for v1. Persist it only if a demonstrated user requirement cannot be met without storage; do not write new configuration solely for an optional preference.

### FR-06: Missing providers and graceful degradation

- If Atelier is missing: do not crash; register the command if possible and explain that Atelier is required for the sidebar panel.
- If `nicobailon/pi-subagents` is missing or RPC capability is absent: present a small informative status (when Atelier is present), not a fake idle fleet.
- If neither is present: remain inert and nonintrusive.
- If RPC times out or returns an error: preserve the last known safe display with a modest stale/unavailable indicator; do not relabel active jobs as finished.
- If a source field is missing: show `—`/omit that field; **no invented model, token or timing data**.
- If only background or only foreground data is available: render accurately and document partial coverage.

### FR-07: Session lifecycle and scope

- Attribute all records to the **current parent Pi session**, not every run from all projects.
- On new session/switch/fork/resume: clear or rebuild the correct view and rebind to the current session.
- On `/reload`: avoid duplicate listeners, duplicate panels and accumulation of old timers.
- On shutdown: clean up all registrations, pending work and timers.
- Late replies and events from the previous session must not mutate the new session's panel.
- Historical current-session runs may be reconstructed from Pi's documented session entries; do not scan unbounded session trees or arbitrary directories.

### FR-08: Capacity and responsiveness

- Adhere to Atelier's published row limits, including 24 max rows, as well as text/length validation.
- Budget rows in this order: summary → active runs → failed runs → completed runs → overflow summary.
- Never discard active runs from the **internal view** due to rendering limits. When the sidebar cannot display all of them, expose `+N more active` based on honest counts.
- Truncate carefully by display width and preserve meaningful task/role information.
- Avoid network calls, credential access, filesystem scans, external processes, and costly recurring work.
- No additional tokens or model invocations for UI updates.

## 6. Architecture and implementation boundaries

Keep the repository small. Use the initialized TypeScript/NPM project and adapt its existing setup rather than reinitializing it.

Preferred modules:

```text
pi-subagents-bar/
  src/
    index.ts       # Pi extension entry point, slash command, lifecycle
    monitor.ts     # RPC/event integration, reconciliation, session-scoped view
    atelier.ts     # Atelier registration, rendering, visibility
  tests/            # Targeted Vitest unit/integration tests
  package.json
  tsconfig.json
  README.md
  LICENSE
```

Optional `src/types.ts` only if genuinely helpful. Avoid a general-purpose event framework, state store, custom UI framework, bundler, web server, SQLite, WebSockets or timers that fetch status indefinitely.

### Responsibilities

**`index.ts`**
- Register `/subagents-bar` using the documented `pi.registerCommand` API.
- Own lifecycle and coordinate monitor + view adapters.
- Handle missing integrations without disturbing the user's installed extensions.

**`monitor.ts`**
- Subscribe and query via public `pi-subagents` contracts.
- Normalize foreground/background/current-session records.
- Deduplicate and classify state; keep bounded history.
- Expose a small snapshot/update interface to the renderer.

**`atelier.ts`**
- Register exactly one namespaced sidebar panel via public protocol v1.
- Compute summary/rows within Atelier's limits.
- Implement expanded/collapsed display and clean lifecycle.
- Only present data; never modify run state.

### Dependencies

- TypeScript strict, ESM, npm; Node.js at least the minimum required by the installed Pi/Atelier versions (Atelier documents Node 22.19+).
- Use the current Pi SDK type package in dev dependencies; Pi supplies runtime APIs.
- Vitest for lightweight automated tests, if already in the initialized package.
- Declare `pi.extensions` correctly in `package.json`, pointing at `./src/index.ts`.
- Avoid runtime imports of `pi-atelier`, `pi-subagents` or unrelated extension packages unless their public entry point is **reliably resolvable and explicitly documented**. Prefer EventBus.
- Keep `private: true` during development; npm publishing is a separate task.

## 7. Testing and validation

Use **proportionate, lightweight** tests. Do not run full application suites, browsers/Playwright, unrelated builds, or costly autonomous test runs. Test pure normalization and rendering with fixture data, and perform a short interactive smoke test on the user's existing setup.

### Unit test matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| UT-01 | Running, failed and completed out of order | Correct priority grouping |
| UT-02 | Two concurrent runs with same agent name | Both visible as separate executions |
| UT-03 | Snapshot updates followed by terminal records | No duplicated job |
| UT-04 | Missing model or token information | Honest omissions, no made-up values |
| UT-05 | Queued, paused, stopped and unknown states | Correct, nonmisleading labels |
| UT-06 | Over 24 rows / long Unicode task | Valid bounded output and overflow counts |
| UT-07 | Late reply after session switch | Old state ignored |
| UT-08 | Repeated event bursts | Coalesced status requests, latest state wins |
| UT-09 | Unavailable/failed RPC | Graceful status, no crash |
| UT-10 | `/subagents-bar` hide/show/toggle | Idempotent correct mode transitions |
| UT-11 | Reload/teardown | No duplicate registrations or leaked timers |
| UT-12 | Background + foreground jobs | Correct coverage and session attribution |

### Integration and manual smoke tests

1. Start Pi with the user's latest Atelier and `nicobailon/pi-subagents`, and this extension loaded locally (`pi -e ./src/index.ts`) or from a safe local package install; ensure the extension is not loaded twice.
2. Enable the `Subagents` panel in `/atelier display` if necessary.
3. Launch two harmless independent read-only subagents in parallel using existing Pi subagent functionality. Verify the live states and their task/role/model/duration/tokens as available.
4. Let one finish successfully; use a controlled, harmless failing fixture for another. Verify ordering and counts.
5. Verify foreground execution coverage if your harness uses it.
6. Run `/subagents-bar hide`, `/subagents-bar show`, `/subagents-bar toggle` and bare `/subagents-bar`. Verify behavior without disturbing other Atelier panels.
7. Resize the terminal / reduce sidebar width. Verify truncation and no broken layout.
8. Trigger `/reload` and a session switch. Check restored state, no duplicates and no old-session leakage.
9. Confirm `pi-profile-cycler` model/profile switching and `pi-subscription-panel` still display and operate normally.
10. Confirm there are **no new LLM tools, prompts, context injections, agent spawns, or network calls** from `pi-subagents-bar`.

Do not run destructive shell commands or touch production repositories to simulate failures.

## 8. Implementation sequence for the agent

**Phase A — Contract verification (required first)**

- Inspect installed package metadata and the exact public APIs of Pi, Atelier and `nicobailon/pi-subagents`.
- Confirm the display protocol, identity fields, lifecycle hooks, event names, session reading methods, and command parser.
- Investigate whether plugin-only full panel visibility changes can be performed safely. If not, choose the specified summary-only collapse semantics.
- Report any discrepancy with this PRD and use the narrowest documented solution. Do **not** invent APIs.

**Phase B — Minimal MVP**

- Implement registration and a static diagnostic panel.
- Implement background RPC status, event subscriptions, normalization and prioritized rendering.
- Add commands and row-limit handling.

**Phase C — Completeness and resilience**

- Add foreground progress, terminal records, current-session history and missing-data behavior.
- Cover reload, session switches, concurrent updates and stale replies.
- Add concise tests and manual smoke validation.

**Phase D — Delivery**

- Complete README, package metadata, license and changelog if needed.
- Run only relevant checks (typecheck + focused tests + manual smoke).
- Produce a compatibility report and list of any known limitations.
- Do not publish to npm, create a GitHub release, commit or push unless separately authorized.

## 9. README requirements

README must be written in English, concise but sufficient for an open-source user. Include:

- What the extension does and **does not** do.
- Compatibility requirements: Pi + Atelier + `nicobailon/pi-subagents` (not other similarly named implementations).
- Local development/test instructions and later standard npm installation syntax once published.
- `pi.extensions` manifest/entry point.
- Important first-run step: enable the `Subagents` panel via `/atelier display`.
- Commands and their exact semantics.
- Display priority and missing-field behavior.
- Scope of session history and known limitations of foreground/background APIs.
- Troubleshooting: no panel, inactive panel, missing provider, no tokens, duplicates or stale data.
- No telemetry, no credential collection, no LLM tools or injected prompts.
- Attribution to upstream projects and references, without claiming official affiliation.

## 10. Quality, security and compatibility constraints

- **Read-only observer.** Never invoke RPC `spawn`, `stop`, `steer`, `interrupt`, `resume` or mutate subagent jobs.
- No private API access, no monkey-patching, no parsing tool text to infer state when a public structured contract exists.
- No hard-coded local user paths, secrets, provider keys, account data or machine-specific details.
- Sanitize or normalize provider-supplied display text to comply with Atelier's plain-text limits; protect against ANSI/control characters and maliciously long task titles.
- Handle exceptions in event listeners, RPC callbacks and rendering gracefully.
- Do not interfere with `pi-profile-cycler`, `pi-subscription-panel`, Atelier status/footer, subagent execution or command routing.
- Do not register editor/footer widgets or set custom Pi UI components outside Atelier's sidebar protocol.
- Favor stable public APIs over internal module imports; do not add new dependencies to solve simple problems.
- Avoid loading the installed `pi-subagents` package a second time as a nested runtime dependency.
- Preserve the user's `asyncWidget: false` setting and other existing extension configuration; do not re-enable unwanted under-editor widgets.
- All updates must remain bounded and session-scoped.

## 11. Definition of Done

The feature is complete only when:

- [ ] The plugin loads without errors in the target Windows/Pi environment.
- [ ] Exactly one `Subagents` panel is registered in Atelier using public APIs.
- [ ] First-run visibility instructions accurately account for Atelier's hidden-by-default panels.
- [ ] Running, failed and completed executions appear in the required priority order.
- [ ] Task, role, model, duration and tokens are shown whenever source data supports them.
- [ ] Background and foreground execution paths are covered or gaps are explicitly documented and not presented as complete.
- [ ] Terminal runs can be reconciled without misclassifying or duplicating executions.
- [ ] Command behaviors are documented and tested, including the supported collapse/hide semantics.
- [ ] Overflow, truncation, empty states and missing APIs are handled safely.
- [ ] `/reload` and session changes do not leak old data or listeners.
- [ ] Existing Atelier, profile cycler and subscription panel remain functional.
- [ ] No new agent prompts, LLM tools, orchestration systems or recurring status polling are introduced.
- [ ] Focused tests and a short manual smoke test pass.
- [ ] README and package metadata are ready for later npm/GitHub publication.
- [ ] Final report lists verified compatibility, files changed, tests run and any limitations.

## 12. Final implementation report format

Return a short technical delivery summary:

1. **Implemented:** behavior and files changed.
2. **Compatibility:** exact inspected Pi/Atelier/`pi-subagents` versions and public protocols used.
3. **Commands:** documented actual hide/show/toggle behavior and Atelier enablement steps.
4. **Validation:** typecheck, tests and short live smoke outcomes.
5. **Limitations:** missing metrics, partial foreground/history coverage or unsupported behavior, if any.
6. **Next steps:** only essential remaining items before a separate npm publication task.

**Do not claim feature completeness where a public API cannot supply the required information.** Preserve existing harness behavior, keep the implementation small, and never introduce a second orchestration layer.

---

## Primary source references

- Pi Extensions: https://pi.dev/docs/latest/extensions
- Pi Atelier: https://github.com/michaelmjhhhh/pi-atelier
- Atelier sidebar implementation: https://github.com/michaelmjhhhh/pi-atelier/blob/main/src/sidebar-panels.ts
- pi-subagents public integration API: https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md
- Reference (monitoring pattern): https://github.com/fan56/pi-sidebar-panel
- Reference (Atelier Fleet integration): https://github.com/saifymatteo/pi-orchestrator
