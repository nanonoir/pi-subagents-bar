# pi-subagents-bar

**Live subagent monitoring inside the Pi Atelier sidebar.**

`pi-subagents-bar` adds a compact **Subagents** panel to [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier). It shows what your [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) children are doing: task, agent, model, duration and tokens. Active work is listed first.

```text
▼ Subagents
● 1 run · ✓ 2 done · ✕ 1 err
[●] Implement sidebar rows (implementer) · sonnet
  ↳ ⏱ 01:42 · 18,200 tok
[✕] Run provider smoke (reviewer) · gpt-6.1-terra
  ↳ ⏱ 00:37 · 4,120 tok
[✓] Review PR33 and PR34 (reviewer) · gpt-6.1-terra
  ↳ ⏱ 06:20 · 79,937 tok
```

The example is approximate; Atelier controls the frame, width and colors.

## Highlights

- **Foreground and background runs** in one place, including completed children restored from the current session branch.
- **Clear priority:** active → failed → other → done.
- **Honest data:** no guessed matches and no invented values. Missing fields are omitted, and rows are merged only when identities match exactly.
- **Lightweight:** event-driven updates and no status polling. A local timer only refreshes elapsed time while something is running.
- **Read-only and safe:** no LLM tools, prompts, telemetry, credentials, configuration writes or spawned processes.

## Requirements

| Component | Tested version |
| --- | --- |
| Node.js | 22.19.0 or later |
| [Pi](https://pi.dev) | 1.5.2 |
| [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) | 0.18.0 |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | 0.88.0 |

Other versions may work but are not guaranteed. The extension has no runtime dependencies; Pi supplies the host SDK.

## Install

```sh
pi install git:github.com/nanonoir/pi-subagents-bar
```

Or try it once without installing, from a local checkout:

```sh
pi -e ./src/index.ts
```

Use only one loading method. Do not combine `-e` with an installed copy.

### Enable the panel

Atelier starts newly contributed panels hidden:

1. Run `/atelier display`.
2. Enable the **Subagents** panel contributed by this extension (`subagents-bar:subagents`).

> Atelier also has a built-in panel named **Subagents** that shows a cost chart. If you see `Cost per agent` curves, you are looking at Atelier's built-in panel, not this one.

## Commands

| Command | Effect |
| --- | --- |
| `/subagents-bar show` | Show the detailed list. |
| `/subagents-bar hide` | Show only the summary and notices. |
| `/subagents-bar` or `/subagents-bar toggle` | Switch between the two. |

These commands change only this panel's content; they do not enable or disable it in Atelier. The choice persists across session switches and resets on reload.

## Reading the panel

| Marker | Meaning |
| --- | --- |
| `[●]` | Running or queued |
| `[✕]` | Failed |
| `[~]` | Stopped, paused, cancelled, interrupted or unknown |
| `[✓]` | Completed |

- The **title** is the task, or the agent when no task is known.
- The **model** omits its provider prefix and thinking-level suffix.
- The **second row** shows duration and tokens. Words appear only when useful, such as `stale` or `timed out`.
- With many running jobs, each execution collapses to one row. The panel stays within Atelier's 24-row limit and summarizes any overflow.
- **`Partial data`** appears only when the provider could not supply complete records.

## Limitations

- **Snapshot counts:** counts cover records currently held by the panel, not an exact total for the whole session. It keeps up to 100 finished records; active ones are never dropped.
- **Ambiguous data:** provider fleet entries without a run identity are summarized, not shown as rows. Usage that cannot be linked to an exact child is left out.
- **Unconfirmed endings:** a job that disappears from a status update keeps its last known state, marked `stale`, until the provider confirms it ended.
- **Branch switches:** a few late events for tool calls first seen after switching branches cannot be linked reliably to a branch.
- **Fixed symbols:** the panel always uses standard Unicode symbols because Atelier does not share its Nerd Font or plain-text setting with extensions.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| No panel | Confirm the extension is loaded once, then enable it in `/atelier display`. |
| Cost chart instead of task rows | That is Atelier's built-in panel; enable `subagents-bar:subagents`. |
| `Subagent provider unavailable` | Install `nicobailon/pi-subagents`, not a similarly named package. |
| Missing tokens or model | The provider did not report them for that run. |
| Duplicates or old rows | Check for double loading; `/reload` rebuilds the view. |

## Development

```sh
npm ci
npm run typecheck
npm run test:renderer   # also: test:monitor, test:foreground, test:notices, test:cost, test:index
```

An optional smoke test loads the real Pi SDK, provider and Atelier panel registry without calling a model:

```sh
npm run test:providers -- --sdk=/path/to/pi-coding-agent --atelier=/path/to/pi-atelier \
  --subagents=/path/to/pi-subagents --order=provider-first   # repeat with --order=bar-first
```

It checks protocols, not visual layout. For visual checks in the terminal interface, use the [manual smoke checklist](docs/manual-smoke.md). Design notes live in [`docs/`](docs/).

## Credits

This is an independent implementation built on public extension contracts and is not officially affiliated with Pi, Atelier or `pi-subagents`.

- [Pi extensions](https://pi.dev/docs/latest/extensions) · [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Atelier sidebar panel protocol](https://github.com/michaelmjhhhh/pi-atelier/blob/main/src/sidebar-panels.ts)
- [pi-subagents extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md)
- Inspired by [fan56/pi-sidebar-panel](https://github.com/fan56/pi-sidebar-panel) and [saifymatteo/pi-orchestrator](https://github.com/saifymatteo/pi-orchestrator)

## License

[ISC](LICENSE)
