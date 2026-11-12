import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAtelierPanel, type AtelierPanelController } from "./atelier.ts";

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
  let expanded = true; // in-memory preference only

  const dispose = (): void => {
    const current = panel;
    panel = undefined;
    current?.dispose();
  };

  pi.on("session_start", () => {
    dispose();
    panel = createAtelierPanel(pi.events, { expanded });
  });
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
      notify(
        `Subagents content ${expanded ? "expanded" : "collapsed to summary only"}. ${ENABLE_HINT}`,
        "info",
      );
    },
  });
}
