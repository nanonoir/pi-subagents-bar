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
    expect(t.m.snapshot().diagnostics?.join(" ")).toContain("Partial data");
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

describe("metadata retention across exact-identity representations", () => {
  it("single-run notice keeps taskInfo, duration and agent when only the notice represents the run", () => {
    const t = setup(); t.m.start();
    t.m.observeMessage(notice({ runId: "p", source: "foreground", status: "completed", agent: "reviewer", taskInfo: "Review PR33", durationMs: 380_000, childRuns: [{ runId: "c1", agent: "reviewer", status: "completed" }] }));
    expect(t.m.snapshot().records[0]).toMatchObject({ task: "Review PR33", agent: "reviewer", duration: "06:20", category: "success" });
    expect(t.m.snapshot().diagnostics?.join(" ")).not.toMatch(/partial|superseding/i);
    t.m.dispose();
  });

  it("does not copy run-level taskInfo/duration onto one of several children", () => {
    const t = setup(); t.m.start();
    t.m.observeMessage(notice({ runId: "p", status: "completed", taskInfo: "whole run", durationMs: 9000, childRuns: [{ runId: "c1", agent: "a", status: "completed" }, { runId: "c2", agent: "b", status: "completed" }] }));
    for (const r of t.m.snapshot().records) { expect(r.task).toBeUndefined(); expect(r.duration).toBeUndefined(); }
    t.m.dispose();
  });

  it("notice supersedes an async root of the same exact run id and retains its task/model/duration", () => {
    const t = setup(); t.runs([node("p", { label: "Async task", model: "openai/gpt:high", startedAt: 90000, endedAt: 99000, state: "completed" })]); t.m.start();
    t.m.observeMessage(notice({ runId: "p", status: "completed", agent: "reviewer", childRuns: [{ runId: "p", agent: "reviewer", status: "completed" }] }));
    const rows = t.m.snapshot().records;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: "Async task", model: "openai/gpt:high", agent: "reviewer" });
    t.m.dispose();
  });

  it("foreground completion without task keeps task/model from the earlier partial update and same-key rows", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", result("p", [child(0, "Review PR33", { model: "m1", progress: { status: "running", durationMs: 1000 } })]), false);
    t.m.observeTool("a", result("p", [{ index: 0, agent: "worker", exitCode: 0, progressSummary: { durationMs: 5000 } }]), true);
    expect(t.m.snapshot().records[0]).toMatchObject({ task: "Review PR33", model: "m1", duration: "00:05", category: "success" });
    t.m.dispose();
  });

  it("completion notice with child runId fills a foreground row's missing metadata by exact alias only", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", result("p", [{ index: 0, runId: "c1", agent: "worker", detached: true }]), true);
    t.m.observeMessage(notice({ runId: "p", status: "completed", taskInfo: "Task X", durationMs: 4000, childRuns: [{ runId: "c1", agent: "worker", status: "completed" }] }));
    expect(t.m.snapshot().records).toHaveLength(1);
    expect(t.m.snapshot().records[0]).toMatchObject({ category: "success", task: "Task X", duration: "00:04" });
    t.m.dispose();
  });

  it("normal supersession is silent; real partial coverage says 'Partial data'", () => {
    const t = setup(); t.runs([node("p")]); t.m.start();
    t.m.observeTool("a", result("p", [child(0, "fg")]), false);
    expect(t.m.snapshot().diagnostics?.join(" ")).not.toMatch(/partial|superseding/i);
    t.m.observeMessage(notice({ runId: "p", childRuns: [{ status: "completed" }] }));
    expect(t.m.snapshot().diagnostics).toContain("Partial data");
    t.m.dispose();
  });
});
