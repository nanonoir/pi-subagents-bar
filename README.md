# pi-subagents-bar

A read-only Pi extension that contributes a **Subagents** panel to the existing Pi Atelier sidebar. It observes foreground and background executions from **[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)**, not other similarly named providers. It does not start or control jobs, add LLM tools or prompts, collect credentials or telemetry, write configuration, spawn processes, or poll for status. Updates use public events and RPC; an active-only timer can refresh displayed elapsed time without RPC polling.

## Requirements and local trial

Use Node.js 22.19.0 or later, Pi, Atelier, and nicobailon/pi-subagents. The inspected and headless-tested baseline is Pi 1.5.2, Atelier 0.18.0 and pi-subagents 0.88.0; other versions are not guaranteed. Pi supplies the host SDK; the package has no runtime dependency on the other extensions.

From this checkout, with Atelier and pi-subagents already available to Pi, start a temporary trial:

```sh
pi -e ./src/index.ts
```

Alternatively, persistently install the local package with `pi install ./path/to/pi-subagents-bar`. Use one loading method at a time: do not also pass `-e` when the package is already loaded. The manifest's `pi.extensions` points to `./src/index.ts`.

**First run:** Atelier starts newly contributed panels hidden. Open `/atelier display` (or Atelier Settings → Display) and enable **Subagents**. The extension cannot detect or change Atelier's enabled layout.

This package is private and **not published to npm**. After a separate future publication, the standard Pi syntax would be `pi install npm:pi-subagents-bar`; it is not currently available from npm.

## Commands

| Command | Effect on this extension's content |
| --- | --- |
| `/subagents-bar show` | Expand the detailed list. |
| `/subagents-bar hide` | Collapse to summary and diagnostics only. |
| `/subagents-bar toggle` or `/subagents-bar` | Toggle between expanded and summary-only. |

`show` and `hide` are idempotent; the preference is in memory. None of these commands enables or disables Atelier's panel. If it is not visible, use `/atelier display`.

## Reading the panel

Known active executions appear first, then failures, neutral states, and successes. Stopped, cancelled, paused, interrupted and unknown states are not successes. Task/label, role, model, duration and token usage appear only when structured source data supplies them. Text is sanitized and bounded; Atelier clips it to the actual sidebar width. Rows are not interactive.

Counts describe known retained records, not an exact all-session total. Provider fleet counts are separate and must not be added to those counts. There are at most 24 displayed rows, with overflow indicated; active records are not discarded to make room for history. Up to 100 non-active records are retained in memory, with a `history limited` indication when evicted. History is reconstructed from available current-session branch records and provider data; switching sessions or branches rebuilds the view, not a global history.

Fleet keys are opaque and cannot safely be joined to execution identities: fleet-only activity is summarized, not rendered as guessed jobs. Bounded or malformed projections can leave partial coverage; absent entries do not prove a job finished. Last-known active data may remain stale until explicit terminal evidence. Async snapshots do not supply tokens or full task details. Optional terminal cost enrichment uses only unique exact child IDs; ambiguous cost rows remain unassigned. Foreground completion notices without child indices can leave detached multi-child executions unresolved.

## Troubleshooting

- **No panel:** confirm Atelier and this extension are loaded once, then enable Subagents in `/atelier display`. The public protocol cannot confirm panel visibility.
- **Provider unavailable or partial:** check that the installed provider is `nicobailon/pi-subagents` and supports the public RPC capabilities. Foreground and background coverage depends on available structured records.
- **Stale data:** a timeout preserves the last safe state rather than inventing completion. A later provider event or a `/subagents-bar` command can trigger a refresh; verify the current session too.
- **Missing tokens or fields:** the provider may not supply them, or identities may not allow a safe cost join. Missing values are not estimated.
- **Unexpected duplicates or old records:** check for double-loading and the current session/branch; `/reload` rebuilds the view. Unjoinable records are not merged by role or appearance. Report a reproducible case without sharing sensitive session data.

## Development and verification

Install development dependencies locally with `npm ci`, then run `npm run typecheck`. Focused checks are available as `npm run test:monitor`, `test:foreground`, `test:notices`, `test:cost`, `test:index`, `test:renderer` and `test:sidebar` (use `npm run` for each).

The optional no-model provider smoke uses local installed package paths, for example:

```sh
npm run test:providers -- --sdk=/path/to/pi-coding-agent --atelier=/path/to/pi-atelier --subagents=/path/to/pi-subagents --order=provider-first
npm run test:providers -- --sdk=/path/to/pi-coding-agent --atelier=/path/to/pi-atelier --subagents=/path/to/pi-subagents --order=bar-first
```

Optional `--cycler=/path/to/pi-profile-cycler` and `--subpanel=/path/to/pi-subscription-panel` check factory/command coexistence only; the inspected baseline was cycler 1.2.0 and subscription panel 1.0.0. The smoke uses the real Pi SDK, provider RPC and Atelier sidebar registry, **not the Atelier UI**; subscription lifecycle is skipped and no credentials are used. It does not validate visual layout or live subscription operation. For an interactive check, see [manual smoke steps](docs/manual-smoke.md); that visual smoke remains pending.

## References and license

Independent implementation based on public contracts, not copied upstream code; no official affiliation is implied.

- [Pi extensions](https://pi.dev/docs/latest/extensions) and [Pi package documentation](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)
- [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) and its [sidebar panel protocol](https://github.com/michaelmjhhhh/pi-atelier/blob/main/src/sidebar-panels.ts)
- [nicobailon/pi-subagents extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md)
- Monitoring references: [fan56/pi-sidebar-panel](https://github.com/fan56/pi-sidebar-panel) and [saifymatteo/pi-orchestrator](https://github.com/saifymatteo/pi-orchestrator)

ISC — see [LICENSE](LICENSE).
