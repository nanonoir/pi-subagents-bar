# Subagents bar: public-protocol observer

Status: accepted implementation design. Product authority: [PRD](../pi-subagents-bar.md). Execution record: [implementation plan](../exec-plans/completed/implement-subagents-bar.md). This document records technical choices, not additional product scope.

## Boundaries and implementation seams

Implement independently; upstream monitor examples are inspiration, not runtime dependencies or copied code. Retain the PRD's three modules:

- `src/index.ts`: Pi hooks, command parsing, current-session runtime ownership and cleanup. It coordinates the other modules and never changes tool results or context.
- `src/monitor.ts`: public RPC client, source validation, normalized records, explicit-identity reconciliation and bounded history. Expose `snapshot()`, a change callback and `dispose()`; accept the public bus, current session identity/branch reader and clock as small injectable seams, not a generic state framework.
- `src/atelier.ts`: pure row construction plus protocol publisher, discovery replay and expanded/summary-only mode. It consumes snapshots and cannot mutate executions.

Keep shared snapshot types in `monitor.ts` unless a small `types.ts` genuinely removes a cycle. `index.ts` depends on both adapters; the monitor must not depend on Atelier. Strict ESM TypeScript, existing Pi dev types and Vitest suffice. No runtime imports of Atelier/subagents, new runtime dependencies, private registries, filesystem/configuration reads, network calls, subprocesses, polling, new tools, messages to the model or context/prompt hooks.

## Verified compatibility and contract corrections

Verified against installed Pi **1.5.2**, Atelier **0.18.0**, pi-subagents **0.88.0**. These are the initial tested compatibility baseline, not a claim that every earlier release works. Use capability/version checks rather than package discovery at runtime.

Installed package-relative evidence (read-only; do not import these implementations):

| Package files | Relevant contract |
| --- | --- |
| Pi `dist/core/extensions/types.d.ts`, `dist/core/session-manager.d.ts` | `pi.on`/bus unsubscribe functions; session start/shutdown reasons; tool execution and message events; current-branch session entry union |
| Atelier `src/sidebar-panels.ts`, `src/sidebar.ts` | v1 events, revisions/discovery, validation/limits, hidden-by-default layout, final terminal-width clipping |
| subagents `docs/extension-api.md`, `src/extension/rpc.js` | public RPC/events/capabilities; ping session identity; fleet projection and status envelope |
| subagents `src/runs/shared/async-status-projection.d.ts` and `.js`, `src/runs/background/async-status-snapshot.js` | bounded current-session snapshot, node identity/kinds, omitted counts and grouping semantics |
| subagents `src/shared/types.d.ts`, `src/runs/background/notify.js`, `src/slash/subagent-cost.js` | foreground child index/progress/timing; structured completion notices; cost identity limitations |

Important corrections to assumptions in exploratory material:

- Fleet keys are opaque, not hashes to decode or run IDs. The installed implementation can even issue small sequential opaque keys. Fleet includes foreground and async activity, uses a different counting granularity from snapshot roots, and is not history.
- `asyncSnapshot` has **no sessionId**, no task or token fields. `ping`/`ready` expose `session: { sessionId, sessionFile }`. The installed provider filters both fleet and async snapshot to its current session before replying. Snapshot roots have async run IDs; descendant `id` values are node-local identities, not necessarily run IDs.
- `SingleResult.index` is stable across reordered snapshots; neither array position nor `SingleResult.runId` alone replaces `(Details.runId, index)`. A result's optional `runId` is useful additional explicit child identity (notably workflows).
- `SingleResult` has no top-level start/end/duration field. Its `progress.durationMs` and `progressSummary.durationMs` supply child duration. Pi's tool-end `durationMs` measures the whole tool call, not each parallel/chain child.
- Background notice details can also have `source: "foreground"`. The documented notice fields do **not** guarantee the foreground child index, model, tokens or per-child duration. A parent notice can report dispatch completion while its explicit `childRuns` still include running children.
- History notices are **top-level `custom_message` session entries**, not `entry.message.role === "custom"`. Live `message_end` notices instead have `message.role === "custom"` and `message.customType === "subagent-notify"`.
- Atelier provides no registration/visibility acknowledgement, enabled-layout read API, width callback or programmatic show/hide protocol. Do not inspect its configuration to compensate.

## Normalized state and identity

Use a small run-envelope map scoped to one current parent session. A run envelope groups alternative public representations of the **same explicit parent run ID**; it is not a counted job. Retain source provenance, optional child run ID/workflow key, provider timestamps, last observed time and authority separately from display fields.

A display record needs: stable namespaced key, parent identity, status, optional task/agent/model, timing and tokens, provenance, and a stale/coverage flag. Keep identity raw and separate from sanitized display text. Missing values remain absent; zero is valid when explicitly provided. Never copy a field between unrelated records.

Validate unknown payloads at the boundary: object/array shapes, envelope/snapshot versions and kind, bounded nonempty identity strings, finite nonnegative numbers and safe-integer timestamps/indexes/counts. Ignore unknown fields. Missing optional metadata does not invalidate a safe identity; an unknown status yields an explicitly unknown record. Skip records without safe identity, conflicting duplicate IDs/indexes or malformed structure and report partial coverage. Invalid optional metrics are omitted. A malformed source is not an authoritative empty snapshot. Bound inspected strings and node depth/count to the public projection caps; no recursive traversal of arbitrary event payloads.

Identity rules:

- Foreground: tuple `("foreground", Details.runId, result.index)`. Before a run ID arrives use `("tool", toolCallId, index)`; promote only through the **same tool call's** explicit `Details.runId`/`toolCallId` association. Require a nonnegative safe-integer child index; no positional fallback. Preserve `SingleResult.runId` as a child alias where supplied, not as the parent namespace.
- Async: root `runs[].id` identifies the parent. Descendants use tuples of root ID and ancestor node IDs, with node kind included. Treat each ID as opaque: no parsing `step:0`, prefixes, inferred indexes or workflow keys. Repeated same-role jobs remain separate.
- A notice's `runId` identifies its parent; `childRuns[].runId` identifies an individual child when valid. `workflowKey` is parent-scoped. Exact aliases may be used only when both structured records explicitly expose the same identity and its scope; ambiguous one-to-many aliases are not merges.
- Fleet keys have **no** identity edge to any of these records. Role/task/model/time similarity is never a link. Missing/placeholder IDs (including a notice child run ID of `"unavailable"`) do not create global identities.
- A valid session entry ID plus child index can preserve an otherwise identity-poor historical result locally. It is not cross-source correlation evidence. If its relation to live rows is ambiguous, retain a coverage diagnostic instead of an additional potentially duplicate execution row.

### One displayed representation, not the union of all providers

Choose **identity-rich mode**: render structured foreground and async records, **not fleet entry rows**. Do not add a fleet-only fallback list when rich records are absent: it cannot be reconciled safely when later foreground/history arrives. If only fleet is supported, show its aggregate activity with `Identity details unavailable`, not a fake empty monitor or opaque per-job history. This deliberately sacrifices uncorrelatable fleet-only model/token/goal fields to avoid duplicate jobs. It is a documented partial-coverage mode.

Within an explicitly identified parent envelope, choose one child representation, not all of them:

1. Structured foreground `results[]` when available (progress and final results reconcile by stable index).
2. Otherwise, structured notice `childRuns[]` when it supplies usable child identities/statuses.
3. Otherwise, the async snapshot's execution frontier.
4. A single aggregate run row only when there is no usable child representation; label it `run`/`workflow` so it does not pretend to be an individually identified child.

A richer source replacing an incompatible representation **supersedes a projection**, not proves those old projection rows completed. Preserve source facts internally while needed; do not show both versions. Transfer metadata only over explicit unambiguous aliases. If replacement cannot prove exhaustive child coverage, mark the envelope/summary partial; never make up a numeric count of missing children. Do not retain superseded projection rows as extra terminal history.

For snapshot frontiers, recurse through `workflow`/`subagent` containers to their ordinary child nodes, suppressing a container when its children represent the executions. A `step` with an agent represents that child execution; nested ordinary descendants may be shown as additional explicitly scoped executions, but not a second copy of a container's own single-child wrapper. `host-step` is orchestration/host work, not a subagent: do not count/render it as an agent. A workflow with only host work or truncated/unusable children is an aggregate workflow row/diagnostic, not a successful agent. No reconstruction of private workflow graphs. Bounded/ambiguous wrappers must produce partial coverage rather than guessed extra jobs.

Notice selection must respect child statuses, including running children; aggregate `completed` does **not** finish every child. If a notice lacks usable child identities and child rows already exist, update only envelope metadata/diagnostics, not every child's status and not an additional aggregate row. In particular, a foreground notice with only a parent run ID cannot identify one of several indexed children. Do not match by agent name or apply its status to all siblings. A known single-child execution or an exact child alias can be updated; otherwise this is an explicit detached-foreground completion gap.

### Disappearance, precedence and status mapping

Only structured positive evidence supplies a terminal status. An omitted/missing fleet entry, node or root is **not completion**, including a successful empty projection. Fleet is replaceable aggregate observation only; its disappearance never produces a history row. An identity-rich active record absent from a later bounded snapshot keeps its last safe state with `not in latest projection`/stale provenance until explicit terminal evidence or a legitimate source-representation replacement. Do not stop it based on elapsed time, file age, missing events or count subtraction.

Per exact identity, final foreground result/explicit child completion outranks progress; child-specific notice evidence outranks older snapshot state; a newer authoritative snapshot can refine snapshot state. A terminal result cannot regress to running because an in-flight status request or late progress arrived. Keep provider timestamps/source authority and local observation sequence; replay history in branch order, and never use an arbitrary timestamp from another source to infer identity. An explicit new execution has its own identity; do not heuristically reopen a completed one. Contradictory terminal evidence keeps the higher-authority result and a partial diagnostic, rather than silently calling an error success. Parent-level completion is lower precision than any child-specific state.

| Category/order | Source mappings |
| --- | --- |
| Active | `pending`/`queued` → queued, `running` → running |
| Failed | `failed`/`error`/`rejected`, explicit timeout or terminal nonzero exit → failed (retain a concise reason) |
| Neutral/non-success | paused, stopped, interrupted, cancelled, partial, detached, unknown → explicit corresponding neutral label; never `completed` |
| Success | explicit terminal `complete`/`completed`, or terminal foreground exit 0 without non-success flags → completed |

For foreground partials prefer `result.progress.status` (or indexed structured `Details.progress`); initial `exitCode: 0` is **not** success. Match parallel progress by its numeric `index`. For final children check stopped/interrupted/detached/timeout flags before plain exit code. A failed outer tool does not make all already successful siblings fail. Missing/malformed child terminal evidence becomes unknown, not zero-exit success. If the tool ends without child results, close only known still-active children to `unknown (tool ended without child result)`; do not fabricate a job for every management/status/async-launch call. Detached rows remain neutral, awaiting exact terminal evidence.

Within each category sort by known finish/update/start timestamp as appropriate, descending, then stable key. Unknown timestamps sort after known ones; a local observation timestamp is not displayed as execution start/end.

### Metrics and retention

- Foreground model/task/agent come from structured child data. Prefer explicit child final duration (`progressSummary`, then `progress`); never divide/copy tool duration among children. Progress duration is an elapsed observation and may advance locally from that observation only while running; do not invent a wall-clock `startedAt` from it.
- Async times are supplied `startedAt`/`endedAt`; calculate duration only from a valid pair. Notice duration applies to the run, not automatically every child. Snapshot labels are labels, not reconstructed task text or guaranteed role/model fields.
- Preserve supplied usage components. Display token total from explicit total, otherwise sum input/output **only when both exist**. Cache tokens are not silently added to a different total convention. Partial usage can display labeled components rather than a fabricated total.
- Use public `cost` v1 as optional enrichment on session rebuild and completion/`agent_settled`, only while terminal records need usage. Coalesce one outstanding request plus one dirty refresh; no requests per streaming activity or elapsed tick. Join only unique exact child run IDs on both sides. Cost can have several rows with the same parent runId and no child index (chain/parallel); do not distribute, sum onto each child, or join by agent/session path/label. It cannot repair lifecycle state. Failed cost leaves usage absent and does not stale otherwise valid status. No artifact paths are read by this extension.
- Retain at most **100 non-active display records** (terminal or unresolved neutral), newest by the same deterministic ordering; report eviction as `history limited`, not an exact all-session completion count. Active records are never evicted to save finished records. Retain active last-known records even when projection disappears. Do not apply the 24-row display limit to state. Superseded source representations and their aliases are pruned with their envelope once no retained display records need them; no accumulating tombstones/unbounded history database.

## RPC, events and session lifetime

`index.ts` owns one runtime at a time. On `session_start` (startup/reload/new/resume/fork) dispose any prior runtime and create a new session generation using `getSessionId()` plus `getSessionFile()`. On `session_tree`, rebuild branch-derived history for the new active leaf and invalidate pending work even when the UUID is unchanged. Never read other branches/session files or persist a separate history.

Startup flow:

1. Install Pi tool/message hooks and bus ready/change listeners **before** reading state. The known ready and jobs-changed names can be subscribed immediately. Send a UUID-correlated `ping`, registering its reply listener **before** emit (bus delivery can be synchronous).
2. Validate ping protocol, current session identity, methods and capabilities. `events` is on ping's top level, not under `capabilities`. Subscribe to the advertised ready/jobsChanged/asyncStarted/childStatus/asyncComplete/processTerminal names before the first untargeted `status` (`params: {}`). Accept supported versions only. Bus change payloads are invalidation hints, never records to apply directly.
3. Rebuild current branch history using the same normalizers as live events. In `getBranch()`, foreground lives under `type: "message"` → `message.role: "toolResult"`, `toolName: "subagent"`; notices live under `type: "custom_message"`, `customType: "subagent-notify"`, with top-level `details`. Live `message_end` handles custom notices and persisted tool results idempotently. Tool update/end and message delivery must converge, not duplicate rows.
4. Read and validate fleet/snapshot independently. A malformed source cannot erase a valid other source or last safe state. Missing capabilities expose partial/unavailable state. Do not scrape status/tool/notice text.

Use a 250 ms coalescing window, one in-flight status request and one dirty bit. A change during a request demands one follow-up read; do not mark that request's data current/fresh when a newer invalidation is already pending. A reply updates only its captured generation/session/branch and cannot overwrite higher-authority child facts. `ping` can time out after 2 seconds, `status`/`cost` after 5 seconds. Clean reply listeners and timers on success, timeout, disposal and rejection. Timeouts preserve last safe records plus a stale/unavailable indicator; no periodic retries. Ready events, further documented changes or an explicit user command can reconnect. `show`/toggle need not await RPC to change content mode.

Since snapshots carry no session ID, acceptance relies on the matched ping session, documented provider scoping, captured request generation and rechecking the live context identity before applying. Do not pretend this is an end-to-end session-tagged status protocol. Ignore mismatched ready/ping sessions and await the correct ready/change/explicit refresh; no cached old-session display while binding a new session.

Shutdown invalidates generation first, unsubscribes all owned Pi/bus hooks, cancels local timers/pending callbacks and unregisters the panel exactly once. A late provider reply need not be cancellable to be ignored. No permanent elapsed timer is necessary for the first increment; a single 1-second display-only timer while observed running records exist is acceptable later, never RPC. Frozen/stale records do not keep advancing a fake elapsed clock.

## Atelier publication and commands

Publish protocol v1 on `pi-atelier:sidebar-panels` with source `subagents-bar`, ID `subagents-bar:subagents`, title `Subagents`. `subagents` alone is a built-in ID and invalid as a contribution. Use `register` for updates, monotonic positive safe-integer revisions per source, `unregister` for disposal. Subscribe before initial register; validate a v1 `discover` and bounded requestId, replay the latest contribution echoing that requestId even when content has not changed. Discovery/update/disposal all consume revisions.

The publisher owns a tiny process-local revision allocator keyed by public bus identity (an extension-owned `Symbol.for` slot containing a WeakMap is sufficient). Replacing a publisher on the same bus must not reset revision to one after an unregister. This is solely our own state, not access to either provider's private registries. Guard disposed publishers so old callbacks cannot publish after replacement. Do not repeatedly unregister/register for collapse.

Use plain text rows and documented semantic roles only. Prefer **ASCII status markers/labels always**, so no config read is needed for Atelier's plain-font preference. Bound raw text before sanitizing; remove ANSI/OSC escapes, control characters and line breaks; cap output by Unicode code points to 160 per row (title 48). Let Atelier perform final display-width clipping at its actual sidebar width; v1 provides no producer width. Do not guess width or install a second renderer.

Expanded rows: summary first; reserve diagnostic/overflow space; then two rows per selected execution (task/label + agent, followed by available model/duration/tokens). Allocate active → failed → neutral → success. At most 24 rows total; collapse to one row per execution if that materially preserves active visibility. Reserve a final compact overflow row for hidden known active/failed/neutral/completed counts. Never label every undisplayed record `done`.

Counts are **known retained records**, not total session history. Show fleet separately, e.g. `Provider: 8 active; 2 outside fleet window`; do not add `fleet.totalActive`, `fleet.omitted` or `asyncSnapshot.omitted` to known-record counts. Snapshot `omitted.runs`, `omitted.children`, `byteLimitExceeded` indicate projection truncation, not necessarily active jobs. Keep them distinct from renderer overflow (`+N more known active`) and history eviction. Invalid/missing counts are omitted with a partial diagnostic, not replaced by zero. One compact diagnostic row may combine these warnings without misleading arithmetic.

The bare command and `toggle` toggle expanded/summary-only; `show`/`hide` set them idempotently. `hide` retains counts/diagnostics and changes no Atelier layout. Unknown/multiple arguments return usage. Commands use `ctx.ui.notify` only when UI is available; no transcript/model message. Always explain that the content is expanded/collapsed **and** `Enable Subagents via /atelier display if not visible; Atelier is required`. Never claim enablement/registration success: discovery proves a consumer asked, not that this panel is enabled (and absence of discovery does not prove Atelier missing). README carries the same first-run instruction. Preference is in-memory; no configuration files are read or written.

## Validation and coherent delivery increments

No tests are required to execute for this design-only change. Implementation should use small focused Vitest files and fake public transports/session contexts, not copied provider implementations, browser suites or real model work:

1. **Sidebar seam**: strict TS/check scripts, publisher + diagnostic snapshot, command mode parsing. Test envelope/discovery echo, monotonic revisions across replacement, teardown, sanitized Unicode/control input, row limits and command feedback without visibility acknowledgement.
2. **Identity-rich background seam**: ping/status lifecycle, capability validation, async frontier, separate fleet diagnostics, optional terminal cost join. Test absent provider, synchronous replies, event bursts/in-flight invalidation, malformed data, provider omissions vs display overflow, disappearing projections, duplicate roles and terminal precedence. It must clearly say foreground/history coverage is pending until increment 3; no temporary mixed fleet job list to undo later.
3. **Foreground/history seam**: shared live/branch normalizers, exact parent/child reconciliation, authority and session generation. Test reordered child indexes, provisional identity promotion, per-child timing, zero-exit partials, grouped/foreground notices without child index, workflow parent/child suppression, ambiguous cost IDs, repeated delivery, retention, late replies/callbacks and branch/session replacement. This completes the intended coverage without changing the publisher seam.

Run focused tests and typecheck for each increment. Headless installed-provider smoke can verify loading and public protocol interoperability without spawning/model calls; it does not prove terminal clipping, user enablement, visual resize, or profile/subscription coexistence. Those require the PRD's brief interactive smoke and must be reported separately if unavailable.

## Deliberate API limitations (document in README)

- Identity-rich mode cannot attach opaque fleet-only metrics to async/foreground executions, and cannot promise full coverage beyond bounded provider projections. Aggregate provider counts are not additive with the monitor's rows.
- Async labels/step metadata are not full task text; snapshot has no tokens. Cost may supply terminal usage only where unique exact IDs permit. Multiple cost rows without indexes remain unassigned.
- Legacy/malformed records without safe identities are diagnosed, not heuristically duplicated. Snapshot node IDs are not universal child run IDs; replacing representations can lose uncorrelatable metadata.
- A foreground completion notice may omit the child index; a multi-child detached run can therefore remain neutral/unresolved until another structured source identifies that child. Parent dispatch completion is not all-child success.
- Missing projection entries never establish completion. Last-known active entries can remain stale until terminal evidence; reload restores only facts still present on the current branch/provider.
- Same-session late tool events for previously unseen tool IDs may still be observed after branch navigation. The public event has no branch tag, so exact attribution is not guaranteed; known prior calls and old RPC replies are ignored.
- Expanded display preference is held in-memory within the extension factory closure; it persists across session changes within the running extension instance, but resets on extension reload.
- The public Atelier protocol cannot report presence, visibility, width or force-enable a panel. No config workaround, private import or installed-extension modification is part of this design.

No pending technical decisions; these are explicit degraded behaviors, not blockers to the independent implementation.
