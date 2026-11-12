import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COALESCE_MS, COST_TIMEOUT_MS, JOBS_CHANGED_EVENT, RPC_REPLY_PREFIX, RPC_REQUEST_EVENT, createMonitor } from "../src/monitor.ts";
import type { EventTransport } from "../src/types.ts";

const SESSION = { sessionId: "session", sessionFile: null };
const tool = (parent: string, rows: unknown[], mode = "parallel") => ({ details: { runId: parent, mode, results: rows } });
const child = (index: number, task: string, extra: object = {}) => ({ index, task, agent: "worker", exitCode: 0, ...extra });
const costRow = (runId: string, input: number, output: number) => ({ runId, usage: { input, output } });
const report = (children: unknown[]) => ({ version: 1, children });
const notice = (runs: unknown[]) => ({ role: "custom", customType: "subagent-notify", details: { runs } });

function setup(options: { cost?: boolean; branch?: unknown[]; runs?: unknown[] } = {}) {
  let branch = options.branch ?? [];
  let session = SESSION;
  let seq = 0;
  const sent: { method: string; requestId: string }[] = [];
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  const events: EventTransport = {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => { set.delete(fn); }; },
    emit(name, value) {
      if (name === RPC_REQUEST_EVENT) {
        const req = value as { method: string; requestId: string }; sent.push(req);
        if (req.method === "ping") answer(req.requestId, { version: 1, methods: options.cost === false ? ["status"] : ["status", "cost"], capabilities: { status: true, ...(options.cost === false ? {} : { cost: { version: 1 } }), asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 } }, session });
        if (req.method === "status") answer(req.requestId, { asyncSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1, omitted: { runs: 0, children: 0 }, runs: options.runs ?? [] } });
      }
      for (const fn of [...(listeners.get(name) ?? [])]) fn(value);
    },
  };
  const answer = (requestId: string, data: unknown, success = true) => events.emit(RPC_REPLY_PREFIX + requestId, { version: 1, requestId, success, ...(success ? { data } : { error: { code: "failure" } }) });
  const m = createMonitor({ events, getSession: () => session, getBranch: () => branch, uuid: () => `id-${++seq}` });
  return { m, events, sent, answer, costs: () => sent.filter(r => r.method === "cost"), branch: (v: unknown[]) => { branch = v; }, session: (v: typeof SESSION) => { session = v; } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("optional cost v1", () => {
  it("joins unique exact child IDs, rejects duplicates, preserves explicit usage and zeroes", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("call", tool("parent", [child(0, "zero", { runId: "zero", usage: { totalTokens: 0 } }), child(1, "one", { runId: "one" }), child(2, "duplicate", { runId: "dup" }), child(3, "no-id")]), true);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(t.costs()).toHaveLength(1);
    t.answer(t.costs()[0]!.requestId, report([costRow("zero", 7, 8), costRow("one", 0, 0), costRow("dup", 1, 2), costRow("dup", 3, 4), costRow("parent", 20, 30)]));
    const rows = Object.fromEntries(t.m.snapshot().records.map(r => [r.task, r]));
    expect(rows.zero.tokens).toBe("0 tok");
    expect(rows.one.tokens).toBe("0 tok");
    expect(rows.duplicate.tokens).toBeUndefined();
    expect(rows["no-id"].tokens).toBeUndefined();
    expect(rows.one.statusLabel).toBe("completed");
    t.m.dispose();
  });

  it("matches explicit single parent and notice aggregate, not parallel parent or descendant node IDs", () => {
    const t = setup({ runs: [
      { id: "root", kind: "subagent", state: "completed" },
      { id: "workflow", kind: "workflow", state: "running", children: [{ id: "node", kind: "step", agent: "x", state: "completed" }] },
    ] }); t.m.start();
    t.m.observeTool("single", tool("single-parent", [child(0, "single")], "single"), true);
    t.m.observeTool("multi", tool("multi-parent", [child(0, "multi-a"), child(1, "multi-b")]), true);
    t.m.observeMessage(notice([{ runId: "bg", status: "completed", agent: "bg" }]));
    vi.advanceTimersByTime(COALESCE_MS);
    t.answer(t.costs()[0]!.requestId, report([costRow("root", 1, 2), costRow("node", 5, 5), costRow("workflow", 6, 6), costRow("single-parent", 2, 3), costRow("multi-parent", 10, 10), costRow("bg", 4, 4)]));
    const rows = t.m.snapshot().records;
    expect(rows.find(r => r.task === "single")?.tokens).toBe("5 tok");
    expect(rows.find(r => r.agent === "bg")?.tokens).toBe("8 tok");
    expect(rows.find(r => r.key.includes("root"))?.tokens).toBe("3 tok");
    expect(rows.find(r => r.agent === "x")?.tokens).toBeUndefined();
    expect(rows.filter(r => r.task?.startsWith("multi-")).every(r => !r.tokens)).toBe(true);
    t.m.dispose();
  });

  it("uses only validated usage components and never applies unsupported or oversized reports", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", tool("p", [child(0, "a", { runId: "a" }), child(1, "b", { runId: "b" }), child(2, "c", { runId: "c" })]), true);
    vi.advanceTimersByTime(COALESCE_MS);
    t.answer(t.costs()[0]!.requestId, { version: 2, children: [costRow("a", 2, 3)] });
    expect(t.m.snapshot().records.every(r => !r.tokens)).toBe(true);
    t.m.agentSettled(); vi.advanceTimersByTime(COALESCE_MS);
    t.answer(t.costs()[1]!.requestId, report(Array.from({ length: 1001 }, () => costRow("a", 2, 3))));
    expect(t.m.snapshot().records.every(r => !r.tokens)).toBe(true);
    t.m.agentSettled(); vi.advanceTimersByTime(COALESCE_MS);
    t.answer(t.costs()[2]!.requestId, report([{ runId: "a", usage: { input: 0 } }, { runId: "b", usage: { input: -1, output: 4 } }, { runId: "c", usage: { input: NaN, output: -2 } }]));
    const rows = Object.fromEntries(t.m.snapshot().records.map(r => [r.task, r.tokens]));
    expect(rows).toEqual({ a: "0 in", b: "4 out", c: undefined });
    t.m.dispose();
  });

  it("does not join a cost ID shared by multiple selected executions", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", tool("p", [child(0, "a", { runId: "shared" }), child(1, "b", { runId: "shared" })]), true);
    t.m.agentSettled(); vi.advanceTimersByTime(1000);
    expect(t.costs()).toHaveLength(0);
    expect(t.m.snapshot().records.every(r => !r.tokens)).toBe(true);
    t.m.dispose();
  });

  it("rebuild triggers cost; missing capability, streams, elapsed ticks and status refresh do not", () => {
    const entry = { type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "a", ...tool("p", [child(0, "old", { runId: "child" })]) } };
    const t = setup({ branch: [entry] }); t.m.start(); vi.advanceTimersByTime(COALESCE_MS);
    expect(t.costs()).toHaveLength(1);
    t.answer(t.costs()[0]!.requestId, report([costRow("child", 3, 4)]));
    t.m.observeTool("live", tool("live", [child(0, "live", { progress: { status: "running", durationMs: 1000 } })]), false);
    t.events.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(5000);
    expect(t.costs()).toHaveLength(1);
    t.m.dispose();
    const u = setup({ cost: false, branch: [entry] }); u.m.start(); u.m.agentSettled(); vi.advanceTimersByTime(1000);
    expect(u.costs()).toHaveLength(0); u.m.dispose();
  });

  it("coalesces while in flight, follows dirty completion once and does not stale on timeout/error", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", tool("p", [child(0, "a", { runId: "a" })]), true);
    vi.advanceTimersByTime(COALESCE_MS);
    t.m.observeTool("b", tool("q", [child(0, "b", { runId: "b" })]), true);
    t.m.agentSettled(); t.m.agentSettled();
    expect(t.costs()).toHaveLength(1);
    t.answer(t.costs()[0]!.requestId, report([costRow("a", 1, 2)]));
    vi.advanceTimersByTime(COALESCE_MS);
    expect(t.costs()).toHaveLength(2);
    vi.advanceTimersByTime(COST_TIMEOUT_MS);
    expect(t.m.snapshot().records.find(r => r.task === "a")?.tokens).toBe("3 tok");
    expect(t.m.snapshot().diagnostics?.join(" ")).not.toMatch(/cost|stale/);
    t.m.agentSettled(); vi.advanceTimersByTime(COALESCE_MS);
    t.answer(t.costs()[2]!.requestId, {}, false);
    expect(t.m.snapshot().records.find(r => r.task === "b")?.category).toBe("success");
    t.m.dispose(); expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late replies after branch change, session change or disposal", () => {
    const t = setup(); t.m.start();
    t.m.observeTool("a", tool("p", [child(0, "old", { runId: "a" })]), true);
    vi.advanceTimersByTime(COALESCE_MS); const old = t.costs()[0]!.requestId;
    t.branch([]); t.m.resetBranch(); t.answer(old, report([costRow("a", 5, 5)]));
    expect(t.m.snapshot().records).toEqual([]);
    t.m.observeTool("b", tool("q", [child(0, "new", { runId: "b" })]), true);
    vi.advanceTimersByTime(COALESCE_MS); const next = t.costs().at(-1)!.requestId;
    t.session({ sessionId: "other", sessionFile: null }); t.answer(next, report([costRow("b", 5, 5)]));
    expect(t.m.snapshot()).toMatchObject({ state: "unavailable", records: [] });
    t.m.dispose(); t.answer(next, report([costRow("b", 5, 5)]));
    expect(vi.getTimerCount()).toBe(0);
  });
});
