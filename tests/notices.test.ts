import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COALESCE_MS, createMonitor, JOBS_CHANGED_EVENT, RPC_REPLY_PREFIX, RPC_REQUEST_EVENT } from "../src/monitor.ts";
import type { EventTransport } from "../src/types.ts";

const session = { sessionId: "s", sessionFile: null };
const notice = (...runs: unknown[]) => ({ role: "custom", customType: "subagent-notify", details: { runs } });
const result = (runId: string, rows: unknown[]) => ({ details: { runId, results: rows } });
const child = (index: number, task: string, extra: object = {}) => ({ index, task, agent: "worker", exitCode: 0, ...extra });
const node = (id: string, extra: object = {}) => ({ id, kind: "subagent", state: "running", label: id, ...extra });

function setup(initial: unknown[] = []) {
  let branch = initial;
  let runs: unknown[] = [];
  let requests = 0;
  let id = 0;
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const events: EventTransport = {
    on(name, handler) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(handler); return () => { set.delete(handler); }; },
    emit(name, value) {
      if (name === RPC_REQUEST_EVENT) {
        requests++;
        const req = value as { method: string; requestId: string };
        const data = req.method === "ping" ? { version: 1, methods: ["status"], capabilities: { status: true, asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 } }, session } : { asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0 }, runs } };
        events.emit(RPC_REPLY_PREFIX + req.requestId, { version: 1, requestId: req.requestId, success: true, data });
      }
      for (const fn of listeners.get(name) ?? []) fn(value);
    },
  };
  const onChange = vi.fn();
  const m = createMonitor({ events, getSession: () => session, getBranch: () => branch, uuid: () => `${++id}`, onChange });
  return { m, events, onChange, requests: () => requests, branch: (v: unknown[]) => { branch = v; }, runs: (v: unknown[]) => { runs = v; }, refresh: () => { events.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(COALESCE_MS); } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.useRealTimers(); });

describe("structured notices", () => {
  it("restores grouped current-branch notices, timestamps order, and deduplicates live delivery", () => {
    const details = { runs: [{ runId: "a", agent: "scout", status: "completed", durationMs: 4000 }, { runId: "b", agent: "reviewer", status: "failed" }] };
    const t = setup([{ type: "custom_message", customType: "subagent-notify", timestamp: "2026-01-02T00:00:00Z", details }, { type: "custom_message", customType: "subagent-notify", timestamp: "2026-01-01T00:00:00Z", details: { runs: [{ runId: "old", status: "completed" }] } }]);
    t.m.start();
    t.m.observeMessage({ role: "custom", customType: "subagent-notify", details });
    expect(t.m.snapshot().records.map(r => r.key)).toHaveLength(3);
    expect(t.m.snapshot().records.map(r => r.agent)).toEqual(["scout", "reviewer", undefined]);
    expect(t.m.snapshot().records[0]).toMatchObject({ category: "success", duration: "00:04" });
    t.branch([{ type: "custom_message", customType: "subagent-notify", details: { runs: [{ runId: "new", status: "stopped" }] } }]);
    t.m.resetBranch();
    expect(t.m.snapshot().records).toHaveLength(1);
    expect(t.m.snapshot().records[0]?.statusLabel).toBe("stopped");
    t.m.dispose();
  });

  it("honors child statuses despite completed parent and never merges placeholder IDs", () => {
    const t = setup(); t.runs([node("p")]); t.m.start();
    t.m.observeMessage(notice({ runId: "p", status: "completed", childRuns: [
      { runId: "c1", agent: "worker", status: "completed" },
      { runId: "c2", agent: "worker", status: "running" },
      { runId: "unavailable", status: "completed" },
    ] }));
    const rows = t.m.snapshot().records;
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.statusLabel).sort()).toEqual(["completed", "running"]);
    expect(t.m.snapshot().diagnostics?.join(" ")).toMatch(/partial coverage/);
    t.m.dispose();
  });

  it("only exact unique child aliases reconcile detached foreground; parent-only notices never finish siblings", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("call", result("p", [child(0, "first", { runId: "c1", detached: true }), child(1, "second", { runId: "c2", detached: true })]), true);
    t.m.observeMessage(notice({ runId: "p", source: "foreground", status: "completed" }));
    expect(t.m.snapshot().records.map(r => r.statusLabel)).toEqual(["detached", "detached"]);
    t.m.observeMessage(notice({ runId: "p", source: "foreground", status: "completed", childRuns: [{ runId: "c1", status: "completed" }] }));
    const rows = Object.fromEntries(t.m.snapshot().records.map(r => [r.task, r.statusLabel]));
    expect(rows).toEqual({ first: "completed", second: "detached" });
    t.m.dispose();
  });

  it("matches workflow keys only within parent and does not apply ambiguous aliases", () => {
    const t = setup(); t.m.start();
    t.m.observeMessage(notice({ runId: "p", childRuns: [{ runId: "unavailable", workflowKey: "k", status: "failed" }] }));
    t.m.observeTool("a", result("p", [child(0, "one", { workflowKey: "k", detached: true })]), true);
    expect(t.m.snapshot().records[0]?.statusLabel).toBe("failed");
    t.m.observeTool("b", result("other", [child(0, "different", { workflowKey: "k", detached: true })]), true);
    expect(t.m.snapshot().records.find(r => r.task === "different")?.statusLabel).toBe("detached");
    t.m.dispose();
  });

  it("promotes exact notice aliases without duplicates and refuses ambiguous foreground aliases", () => {
    const t = setup(); t.m.start();
    t.m.observeMessage(notice({ runId: "p", childRuns: [{ runId: "unavailable", workflowKey: "k", status: "running" }] }));
    t.m.observeMessage(notice({ runId: "p", childRuns: [{ runId: "child", workflowKey: "k", status: "completed" }] }));
    expect(t.m.snapshot().records).toHaveLength(1);
    expect(t.m.snapshot().records[0]?.statusLabel).toBe("completed");
    t.m.observeTool("call", result("p", [child(0, "first", { runId: "child", detached: true }), child(1, "second", { runId: "child", detached: true })]), true);
    expect(t.m.snapshot().records.map(r => r.statusLabel)).toEqual(["detached", "detached"]);
    t.m.dispose();
  });

  it("background parent notice resolves only a single root, not a multi-child frontier", () => {
    const t = setup(); t.runs([node("p", { startedAt: 99000 })]); t.m.start();
    t.m.observeMessage(notice({ runId: "p", status: "completed", agent: "worker", durationMs: 1000 }));
    expect(t.m.snapshot().records).toHaveLength(1);
    expect(t.m.snapshot().records[0]).toMatchObject({ category: "success", task: "p" });
    t.runs([node("p", { kind: "workflow", children: [node("x", { kind: "step", agent: "x" }), node("y", { kind: "step", agent: "y" })] })]);
    t.refresh();
    expect(t.m.snapshot().records.map(r => r.statusLabel)).toEqual(["running", "running"]);
    t.m.dispose();
  });
});

describe("display-only elapsed refresh", () => {
  it("advances from structured observations with no RPC and cleans up on terminal/dispose", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", result("p", [child(0, "fg", { progress: { status: "running", durationMs: 3000 } })]), false);
    const requests = t.requests(); const changes = t.onChange.mock.calls.length;
    expect(t.m.snapshot().records[0]?.duration).toBe("00:03");
    vi.advanceTimersByTime(2100);
    expect(t.m.snapshot().records[0]?.duration).toBe("00:05");
    expect(t.onChange.mock.calls.length).toBeGreaterThan(changes);
    expect(t.requests()).toBe(requests);
    t.m.observeTool("a", result("p", [child(0, "fg", { progressSummary: { durationMs: 5000 } })]), true);
    vi.advanceTimersByTime(5000);
    expect(t.m.snapshot().records[0]?.duration).toBe("00:05");
    expect(vi.getTimerCount()).toBe(0);
    t.m.dispose();
  });

  it("freezes disappeared snapshot duration and has no timer after branch reset", () => {
    const t = setup(); t.runs([node("p", { startedAt: 99000 })]); t.m.start();
    vi.advanceTimersByTime(1000);
    expect(t.m.snapshot().records[0]?.duration).toBe("00:02");
    t.runs([]); t.refresh();
    const frozen = t.m.snapshot().records[0]?.duration;
    vi.advanceTimersByTime(5000);
    expect(t.m.snapshot().records[0]).toMatchObject({ duration: frozen, statusLabel: "running (stale)" });
    expect(vi.getTimerCount()).toBe(0);
    t.m.resetBranch();
    expect(vi.getTimerCount()).toBe(0);
    t.m.dispose();
  });
});
