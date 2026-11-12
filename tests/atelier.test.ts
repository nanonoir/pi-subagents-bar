import { describe, expect, it } from "vitest";
import {
  MAX_ROWS,
  MAX_ROW_CHARS,
  PANEL_ID,
  PENDING_SNAPSHOT,
  SIDEBAR_CHANNEL,
  createAtelierPanel,
  renderPanel,
  sanitizeText,
  type EventTransport,
  type MonitorSnapshot,
  type RecordCategory,
  type SnapshotRecord,
} from "../src/atelier.ts";

function createBus(): EventTransport & { sent: any[] } {
  const handlers = new Set<(d: unknown) => void>();
  const sent: any[] = [];
  return {
    sent,
    on(channel, h) {
      expect(channel).toBe(SIDEBAR_CHANNEL);
      handlers.add(h);
      return () => handlers.delete(h);
    },
    emit(channel, data) {
      expect(channel).toBe(SIDEBAR_CHANNEL);
      sent.push(data);
      for (const h of [...handlers]) h(data);
    },
  };
}

const rec = (key: string, category: RecordCategory, extra: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  key, category, task: `task ${key}`, agent: "worker", ...extra,
});
const ready = (records: SnapshotRecord[], extra: Partial<MonitorSnapshot> = {}): MonitorSnapshot => ({
  state: "ready", records, ...extra,
});
const registers = (bus: { sent: any[] }) => bus.sent.filter((e) => e?.type === "register");

describe("sanitizeText", () => {
  it("strips ANSI/OSC, controls and newlines", () => {
    expect(sanitizeText("a\u001b[31mred\u001b[0m\u001b]8;;http://x\u0007link\nb\r\tc\u0000d")).toBe("a red link b c d");
  });
  it("caps by code points without splitting surrogate pairs", () => {
    const out = sanitizeText("😀".repeat(500));
    expect(Array.from(out).length).toBe(MAX_ROW_CHARS);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("replaces lone surrogates and ignores non-strings", () => {
    expect(sanitizeText("a\uD800b")).toBe("a\uFFFDb");
    expect(sanitizeText(42)).toBe("");
  });
});

describe("renderPanel", () => {
  it("initial pending panel is explicit and not an idle state", () => {
    const p = renderPanel(PENDING_SNAPSHOT, true);
    expect(p.id).toBe(PANEL_ID);
    expect(p.title).toBe("Subagents");
    expect(p.rows[0]?.text).toMatch(/integration pending/);
    expect(JSON.stringify(p)).not.toMatch(/idle|No known/i);
  });

  it("empty ready snapshot says no known records", () => {
    expect(renderPanel(ready([]), true).rows[0]?.text).toBe("No known subagents");
  });

  it("orders active, failed, neutral, success with ASCII markers and omits missing metrics", () => {
    const p = renderPanel(
      ready([
        rec("s", "success"),
        rec("n", "neutral", { statusLabel: "stopped" }),
        rec("f", "failed"),
        rec("a", "active", { model: "m1", duration: "01:02", tokens: "1.2k tok" }),
      ]),
      true,
    );
    const texts = p.rows.map((r) => r.text);
    expect(texts[0]).toBe("Known: 1 active, 1 failed, 1 other, 1 done");
    expect(texts.filter((t) => /^[>x~+] /.test(t)).map((t) => t[0]).join("")).toBe(">x~+");
    expect(texts).toContain("  m1 | 01:02 | 1.2k tok");
    expect(texts).toContain("  stopped");
    expect(texts.join("\n")).not.toMatch(/undefined|NaN|0 tok/);
  });

  it("summary-only mode retains counts and diagnostics but no records", () => {
    const snap = ready([rec("a", "active")], { fleet: { active: 8, outside: 2 }, historyLimited: true });
    const p = renderPanel(snap, false);
    expect(p.rows.map((r) => r.text)).toEqual([
      "Known: 1 active",
      "Provider: 8 active; 2 outside fleet window; history limited",
    ]);
  });

  it("omits invalid fleet counts instead of zero-filling", () => {
    const p = renderPanel(ready([], { fleet: { active: -1 } as never }), true);
    expect(p.rows.map((r) => r.text).join()).not.toMatch(/Provider/);
  });

  it("never exceeds 24 rows or 160 code points and reports overflow honestly", () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => rec(`a${i}`, "active", { task: "😀".repeat(400), model: "m" })),
      ...Array.from({ length: 30 }, (_, i) => rec(`s${i}`, "success", { model: "m" })),
    ];
    const p = renderPanel(ready(records, { diagnostics: ["projection truncated"] }), true);
    expect(p.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    for (const r of p.rows) expect(Array.from(r.text).length).toBeLessThanOrEqual(MAX_ROW_CHARS);
    const last = p.rows[p.rows.length - 1]?.text ?? "";
    expect(last).toMatch(/^\+\d+ more known: \d+ done$/);
    expect(p.rows.filter((r) => r.text.startsWith("> ")).length).toBe(5);
  });

  it("collapses to one row per execution when that preserves active visibility", () => {
    const records = Array.from({ length: 15 }, (_, i) => rec(`a${i}`, "active", { model: "m" }));
    const p = renderPanel(ready(records), true);
    expect(p.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(p.rows.filter((r) => r.text.startsWith("> ")).length).toBe(15);
  });

  it("overflow names hidden active/failed counts, not 'done'", () => {
    const records = Array.from({ length: 40 }, (_, i) => rec(`a${i}`, "active"));
    const p = renderPanel(ready(records), true);
    expect(p.rows[p.rows.length - 1]?.text).toMatch(/more known: \d+ active$/);
  });

  it("sanitizes provider text in rows", () => {
    const p = renderPanel(ready([rec("a", "active", { task: "x\u001b[2Jy\nz", agent: "a\u0007b" })]), true);
    expect(p.rows[1]?.text).toBe("> x y z (a b)");
  });
});

describe("publisher", () => {
  it("subscribes before registering and echoes discovery requestId", () => {
    const bus = createBus();
    const panel = createAtelierPanel(bus);
    expect(registers(bus)).toHaveLength(1);
    expect(registers(bus)[0]).toMatchObject({ version: 1, source: "subagents-bar", revision: 1, panel: { id: PANEL_ID, title: "Subagents" } });
    bus.emit(SIDEBAR_CHANNEL, { version: 1, type: "discover", requestId: "atelier-1" });
    const echoed = registers(bus)[1];
    expect(echoed).toMatchObject({ requestId: "atelier-1", revision: 2 });
    expect(echoed.panel.rows).toEqual(registers(bus)[0].panel.rows);
    panel.dispose();
  });

  it("ignores invalid discovery events", () => {
    const bus = createBus();
    createAtelierPanel(bus);
    for (const bad of [
      { version: 2, type: "discover", requestId: "x" },
      { version: 1, type: "discover" },
      { version: 1, type: "discover", requestId: "bad\nid" },
      { version: 1, type: "discover", requestId: "x".repeat(257) },
      { version: 1, type: "discover", requestId: "  " },
      null,
      "discover",
    ]) bus.emit(SIDEBAR_CHANNEL, bad);
    expect(registers(bus)).toHaveLength(1);
  });

  it("publishes only on content change", () => {
    const bus = createBus();
    let snap = ready([rec("a", "active")]);
    const panel = createAtelierPanel(bus, { snapshot: () => snap });
    panel.refresh();
    expect(registers(bus)).toHaveLength(1);
    snap = ready([rec("a", "failed")]);
    panel.refresh();
    expect(registers(bus)).toHaveLength(2);
    panel.setExpanded(false);
    panel.setExpanded(false);
    expect(registers(bus)).toHaveLength(3);
  });

  it("unregisters exactly once and ignores later calls and discovery", () => {
    const bus = createBus();
    const panel = createAtelierPanel(bus);
    panel.dispose();
    panel.dispose();
    panel.setExpanded(false);
    panel.refresh();
    bus.emit(SIDEBAR_CHANNEL, { version: 1, type: "discover", requestId: "late" });
    expect(bus.sent.filter((e) => e.type === "unregister")).toHaveLength(1);
    expect(bus.sent.find((e) => e.type === "unregister")).toMatchObject({ id: PANEL_ID, source: "subagents-bar" });
    expect(registers(bus)).toHaveLength(1);
  });

  it("keeps revisions monotonic across replacement on the same bus", () => {
    const bus = createBus();
    createAtelierPanel(bus).dispose();
    const second = createAtelierPanel(bus);
    const revs = bus.sent.map((e) => e.revision);
    expect(revs).toEqual([1, 2, 3]);
    second.dispose();
    expect(bus.sent.at(-1).revision).toBe(4);
  });

  it("keeps revisions independent between buses", () => {
    const a = createBus();
    const b = createBus();
    createAtelierPanel(a);
    createAtelierPanel(b);
    expect(a.sent[0].revision).toBe(1);
    expect(b.sent[0].revision).toBe(1);
  });

  it("old publisher cannot publish after replacement disposes it", () => {
    const bus = createBus();
    const old = createAtelierPanel(bus);
    old.dispose();
    const fresh = createAtelierPanel(bus);
    const before = bus.sent.length;
    old.setExpanded(false);
    bus.emit(SIDEBAR_CHANNEL, { version: 1, type: "discover", requestId: "r" });
    // Only the fresh publisher answers discovery (plus the discover event itself).
    expect(bus.sent.length - before).toBe(2);
    fresh.dispose();
  });
});
