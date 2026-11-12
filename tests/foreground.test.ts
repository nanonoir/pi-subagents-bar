import { describe, expect, it } from "vitest";
import { createMonitor, RPC_REPLY_PREFIX, RPC_REQUEST_EVENT } from "../src/monitor.ts";
import type { EventTransport } from "../src/types.ts";

const session = { sessionId: "s", sessionFile: null };
function setup(withRpc = false) {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  let branch: unknown[] = [];
  let current = session;
  let n = 0;
  const events: EventTransport = {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => { set.delete(fn); }; },
    emit(name, value) {
      if (withRpc && name === RPC_REQUEST_EVENT) {
        const req = value as { requestId: string; method: string };
        const data = req.method === "ping" ? { version: 1, methods: ["status"], capabilities: { status: true, asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 } }, session, events: {} } : { asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0 }, runs: [{ id: "parent", kind: "subagent", state: "running", label: "projection" }, { id: "other", kind: "subagent", state: "running", label: "other" }] } };
        events.emit(RPC_REPLY_PREFIX + req.requestId, { version: 1, requestId: req.requestId, success: true, data });
      }
      for (const fn of listeners.get(name) ?? []) fn(value);
    },
  };
  const m = createMonitor({ events, getSession: () => current, getBranch: () => branch, uuid: () => `r${++n}` });
  return { m, branch: (v: unknown[]) => { branch = v; }, session: (v: typeof session) => { current = v; } };
}
const result = (runId: string | undefined, results: unknown[]) => ({ details: { ...(runId ? { runId } : {}), results } });
const child = (index: number, task: string, extra: object = {}) => ({ index, task, agent: "worker", exitCode: 0, ...extra });
const msg = (call: string, details: unknown) => ({ role: "toolResult", toolName: "subagent", toolCallId: call, details });

describe("foreground structured results", () => {
  it("promotes only the same call, reconciles reordered indexes and final messages without duplicates", () => {
    const { m } = setup(); m.start();
    m.observeTool("a", result(undefined, [child(1, "one", { progress: { status: "running", durationMs: 2000, tokens: 9 } }), child(0, "zero", { progress: { status: "pending" } })]), false);
    m.observeTool("b", result(undefined, [child(0, "separate")]), false);
    m.observeTool("a", result("parent", [child(0, "zero", { progress: { status: "running" } }), child(1, "one", { progress: { status: "running" } })]), false);
    m.observeTool("a", result("parent", [child(1, "one", { model: "m1", progressSummary: { durationMs: 5000 }, usage: { input: 4, output: 6 } }), child(0, "zero", { model: "m0", progress: { durationMs: 3000 }, usage: { totalTokens: 20 } })]), true);
    m.observeMessage(msg("a", result("parent", [child(0, "zero", { model: "m0", progress: { durationMs: 3000 }, usage: { totalTokens: 20 } }), child(1, "one", { model: "m1", progressSummary: { durationMs: 5000 }, usage: { input: 4, output: 6 } })]).details));
    m.observeTool("a", result("parent", [child(0, "late", { progress: { status: "running" } })]), false);
    const rows = m.snapshot().records;
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.task === "zero")).toMatchObject({ category: "success", duration: "00:03", tokens: "20 tok", model: "m0" });
    expect(rows.find(r => r.task === "one")).toMatchObject({ category: "success", duration: "00:05", tokens: "10 tok", model: "m1" });
    expect(rows.find(r => r.task === "separate")?.category).toBe("active");
    m.dispose();
  });

  it("zero exit on partial is not success; non-success flags outrank exit and no outer duration is copied", () => {
    const { m } = setup(); m.start();
    m.observeTool("a", result("p", [child(0, "live", { progress: { status: "running" } })]), false);
    expect(m.snapshot().records[0]?.category).toBe("active");
    m.observeTool("a", { ...result("p", [child(0, "cancel", { cancelled: true }), child(1, "detach", { detached: true }), child(2, "timeout", { timedOut: true }), child(3, "interrupt", { interrupted: true }), child(4, "success")]), durationMs: 99000 }, true);
    const rows = Object.fromEntries(m.snapshot().records.map(r => [r.task, r]));
    expect(rows.cancel).toMatchObject({ category: "neutral", statusLabel: "cancelled" });
    expect(rows.detach).toMatchObject({ category: "neutral", statusLabel: "detached" });
    expect(rows.timeout).toMatchObject({ category: "failed" });
    expect(rows.interrupt).toMatchObject({ category: "neutral", statusLabel: "interrupted" });
    expect(rows.success).toMatchObject({ category: "success" });
    expect(rows.success).not.toHaveProperty("duration");
    m.dispose();
  });

  it("suppresses only async projections under the same explicit parent", () => {
    const { m } = setup(true); m.start();
    expect(m.snapshot().records).toHaveLength(2);
    m.observeTool("a", result("parent", [child(7, "foreground")]), false);
    expect(m.snapshot().records.map(r => r.task).sort()).toEqual(["foreground", "other"]);
    m.dispose();
  });

  it("restores only current branch and rejects callbacks from previous branch/session", () => {
    const t = setup();
    t.branch([{ type: "message", message: msg("old", result("old-parent", [child(0, "old")]).details) }]);
    t.m.start(); expect(t.m.snapshot().records.map(r => r.task)).toEqual(["old"]);
    t.branch([{ type: "message", message: msg("new", result("new-parent", [child(4, "new")]).details) }]);
    t.m.resetBranch();
    t.m.observeTool("old", result("old-parent", [child(0, "stale")]), false);
    expect(t.m.snapshot().records.map(r => r.task)).toEqual(["new"]);
    t.session({ sessionId: "different", sessionFile: null });
    t.m.observeTool("new2", result("x", [child(1, "leak")]), false);
    expect(t.m.snapshot()).toMatchObject({ state: "unavailable", records: [] });
    t.m.dispose();
  });

  it("closes known active children without results as unknown and ignores malformed identities", () => {
    const { m } = setup(); m.start();
    m.observeTool("a", result("p", [child(0, "active"), { task: "no index" }, child(2, "duplicate"), child(2, "duplicate2")]), false);
    m.observeTool("a", {}, true);
    expect(m.snapshot().records).toHaveLength(1);
    expect(m.snapshot().records[0]).toMatchObject({ task: "active", statusLabel: "unknown", category: "neutral" });
    expect(m.snapshot().diagnostics?.join(" ")).toContain("tool ended without child result");
    m.dispose();
  });
});
