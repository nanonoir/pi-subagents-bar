import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAtelierPanel, type AtelierPanelController } from "./atelier.ts";
import { createMonitor, type Monitor } from "./monitor.ts";

export const COMMAND_NAME = "subagents-bar";
export const USAGE = "Usage: /subagents-bar [show|hide|toggle]";
const ENABLE_HINT = "Enable Subagents via /atelier display if not visible; Atelier is required.";

export type CommandAction = "show" | "hide" | "toggle";

/** Returns undefined for unknown or multiple arguments. */
export function parseCommand(args: string): CommandAction | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "toggle";
  if (parts.length > 1) return undefined;
  const word = parts[0]?.toLowerCase();
  return word === "show" || word === "hide" || word === "toggle" ? word : undefined;
}

export default function subagentsBar(pi: ExtensionAPI): void {
  let panel: AtelierPanelController | undefined;
  let monitor: Monitor | undefined;
  let expanded = true; // in-memory preference only

  const dispose = (): void => {
    const m = monitor;
    const p = panel;
    monitor = panel = undefined;
    m?.dispose(); // invalidates the generation before the panel goes away
    p?.dispose();
  };

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    dispose();
    const created = createMonitor({
      events: pi.events,
      // Read live so a replaced/stale context never supplies another session's identity.
      getSession: () => {
        const sm = ctx.sessionManager;
        const sessionId = sm.getSessionId();
        return sessionId ? { sessionId, sessionFile: sm.getSessionFile() ?? null } : undefined;
      },
      onChange: () => {
        if (monitor === created) panel?.refresh();
      },
    });
    monitor = created;
    created.start(); // synchronous replies land before the first publish; no duplicate register
    panel = createAtelierPanel(pi.events, { expanded, snapshot: () => created.snapshot() });
  });
  pi.on("session_tree", () => monitor?.resetBranch());
  pi.on("session_shutdown", dispose);

  pi.registerCommand(COMMAND_NAME, {
    description: "Show, hide or toggle the Subagents sidebar content (summary-only when hidden)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = parseCommand(args);
      const notify = (message: string, level: "info" | "warning"): void => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
      };
      if (!action) return notify(USAGE, "warning");
      expanded = action === "toggle" ? !expanded : action === "show";
      panel?.setExpanded(expanded);
      monitor?.refresh(); // fire-and-forget; feedback below never waits on RPC
      notify(
        `Subagents content ${expanded ? "expanded" : "collapsed to summary only"}. ${ENABLE_HINT}`,
        "info",
      );
    },
  });
}
