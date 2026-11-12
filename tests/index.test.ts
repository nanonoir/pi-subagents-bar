import { describe, expect, it, vi } from "vitest";
import subagentsBar, { USAGE, parseCommand } from "../src/index.ts";
import { PANEL_ID, SIDEBAR_CHANNEL } from "../src/atelier.ts";

function setup() {
  const handlers = new Map<string, (...a: any[]) => unknown>();
  const listeners = new Set<(d: unknown) => void>();
  const sent: any[] = [];
  let command: any;
  const pi = {
    events: {
      // Sidebar channel only; monitor RPC traffic is covered in monitor.test.ts.
      on: (c: string, h: (d: unknown) => void) => {
        if (c !== "pi-atelier:sidebar-panels") return () => undefined;
        listeners.add(h);
        return () => listeners.delete(h);
      },
      emit: (c: string, d: unknown) => {
        if (c !== "pi-atelier:sidebar-panels") return;
        sent.push(d);
        for (const l of [...listeners]) l(d);
      },
    },
    on: (name: string, h: (...a: any[]) => unknown) => handlers.set(name, h),
    registerCommand: (name: string, opts: unknown) => (command = { name, ...(opts as object) }),
  };
  subagentsBar(pi as never);
  const ctx = (hasUI = true) => ({ hasUI, ui: { notify: vi.fn() } });
  return {
    sent, listeners, command, handlers,
    start: () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/s1.jsonl" },
    }),
    stop: () => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, {}),
    ctx,
    registers: () => sent.filter((e) => e.type === "register"),
  };
}

describe("parseCommand", () => {
  it("maps arguments", () => {
    expect(parseCommand("")).toBe("toggle");
    expect(parseCommand("  ")).toBe("toggle");
    expect(parseCommand("show")).toBe("show");
    expect(parseCommand(" HIDE ")).toBe("hide");
    expect(parseCommand("toggle")).toBe("toggle");
    expect(parseCommand("bogus")).toBeUndefined();
    expect(parseCommand("show hide")).toBeUndefined();
  });
});

describe("extension lifecycle", () => {
  it("registers only the command and no tools/panel until session start", () => {
    const t = setup();
    expect(t.command.name).toBe("subagents-bar");
    expect([...t.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start", "session_tree"]);
    expect(t.sent).toHaveLength(0);
  });

  it("publishes one connecting (never idle) panel on start", () => {
    const t = setup();
    t.start();
    expect(t.registers()).toHaveLength(1);
    const { panel } = t.registers()[0];
    expect(panel.id).toBe(PANEL_ID);
    expect(panel.rows[0].text).toMatch(/Connecting to subagent provider/);
  });

  it("reload replaces the panel: old unregistered, revisions monotonic, one listener", () => {
    const t = setup();
    t.start();
    t.start();
    expect(t.listeners.size).toBe(1);
    expect(t.sent.map((e) => [e.type, e.revision])).toEqual([
      ["register", 1], ["unregister", 2], ["register", 3],
    ]);
    t.stop();
    t.stop();
    expect(t.listeners.size).toBe(0);
    expect(t.sent.filter((e) => e?.type === "unregister")).toHaveLength(2);
  });

  it("answers discovery only while running", () => {
    const t = setup();
    t.start();
    t.listeners.forEach((l) => l({ version: 1, type: "discover", requestId: "q" }));
    expect(t.registers().at(-1)).toMatchObject({ requestId: "q" });
    t.stop();
    const n = t.sent.length;
    t.listeners.forEach((l) => l({ version: 1, type: "discover", requestId: "q2" }));
    expect(t.sent.length).toBe(n);
    void SIDEBAR_CHANNEL;
  });
});

describe("command", () => {
  it("toggles, shows and hides idempotently with precise feedback", async () => {
    const t = setup();
    t.start();
    const c = t.ctx();
    await t.command.handler("hide", c);
    await t.command.handler("hide", c);
    await t.command.handler("", c);
    await t.command.handler("toggle", c);
    await t.command.handler("show", c);
    const msgs = c.ui.notify.mock.calls.map((x: any[]) => x[0] as string);
    expect(msgs[0]).toMatch(/collapsed to summary only/);
    expect(msgs[1]).toMatch(/collapsed to summary only/);
    expect(msgs[2]).toMatch(/expanded/);
    expect(msgs[3]).toMatch(/collapsed/);
    expect(msgs[4]).toMatch(/expanded/);
    for (const m of msgs) {
      expect(m).toContain("Enable Subagents via /atelier display if not visible; Atelier is required.");
      expect(m).not.toMatch(/enabled successfully|registered|is now visible/i);
    }
  });

  it("returns usage for unknown or multiple arguments without changing mode", async () => {
    const t = setup();
    t.start();
    const c = t.ctx();
    await t.command.handler("nope", c);
    await t.command.handler("show hide", c);
    expect(c.ui.notify.mock.calls).toEqual([[USAGE, "warning"], [USAGE, "warning"]]);
    expect(t.registers()).toHaveLength(1);
  });

  it("does not notify without UI and does not throw", async () => {
    const t = setup();
    t.start();
    const c = t.ctx(false);
    await t.command.handler("hide", c);
    expect(c.ui.notify).not.toHaveBeenCalled();
  });

  it("preference survives reload and works before session start", async () => {
    const t = setup();
    const c = t.ctx();
    await t.command.handler("hide", c);
    t.start();
    expect(t.registers()).toHaveLength(1);
    await t.command.handler("show", c);
    t.start();
    expect(t.registers().at(-1).panel.rows.length).toBeGreaterThan(0);
  });
});
