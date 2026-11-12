import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COALESCE_MS, JOBS_CHANGED_EVENT, MAX_NON_ACTIVE, PING_TIMEOUT_MS, RPC_READY_EVENT,
  RPC_REPLY_PREFIX, RPC_REQUEST_EVENT, STATUS_TIMEOUT_MS, createMonitor,
} from "../src/monitor.ts";
import { renderPanel } from "../src/atelier.ts";

const SESSION = { sessionId: "sess-1", sessionFile: "/s/1.jsonl" };

const EVENTS = {
  ready: RPC_READY_EVENT, request: RPC_REQUEST_EVENT, replyPrefix: RPC_REPLY_PREFIX,
  asyncComplete: "subagent:async-complete", asyncStarted: "subagent:async-started",
  childStatus: "subagent:child-status", processTerminal: "subagent:process-terminal",
  jobsChanged: JOBS_CHANGED_EVENT,
};
const pingData = (session: unknown = SESSION, extra: Record<string, unknown> = {}) => ({
  version: 1,
  methods: ["ping", "status", "cost"],
  capabilities: {
    status: true, fleetStatus: { version: 1 },
    asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
  },
  events: EVENTS,
  session,
  ...extra,
});
const node = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "subagent", label: `label ${id}`, state, ...extra,
});
const snapshot = (runs: unknown[], omitted: unknown = { runs: 0, children: 0, byteLimitExceeded: false }) => ({
  kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: 1, caps: {}, omitted, runs,
});
const statusData = (runs: unknown[], fleet: unknown = { version: 1, entries: [], totalActive: runs.length, omitted: 0 }) =>
  ({ text: "x", fleet, asyncSnapshot: snapshot(runs) });

type Hook = (c: string, d: any) => void;

function createBus() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const sent: { channel: string; data: any }[] = [];
  let hook: Hook = () => undefined;
  return {
    sent,
    setHook: (fn: Hook) => { hook = fn; },
    on(c: string, h: (d: unknown) => void) {
      let set = handlers.get(c);
      if (!set) handlers.set(c, (set = new Set()));
      const s = set;
      s.add(h);
      return () => { s.delete(h); };
    },
    emit(c: string, d: unknown) {
      sent.push({ channel: c, data: d });
      hook(c, d);
      for (const h of [...(handlers.get(c) ?? [])]) h(d);
    },
    count: (c: string) => handlers.get(c)?.size ?? 0,
    total: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

/** Fake provider speaking the real envelope: answers synchronously unless `manual`. */
function provider(opts: { ping?: () => unknown; status?: () => unknown; manual?: boolean } = {}) {
  const bus = createBus();
  const replies = new Map<string, (data: unknown) => void>();
  const wire = (): void => {
    bus.setHook((c, d) => {
      if (c !== RPC_REQUEST_EVENT) return;
      const reply = (data: unknown): void =>
        bus.emit(RPC_REPLY_PREFIX + d.requestId, { version: 1, requestId: d.requestId, method: d.method, success: true, data });
      if (d.method === "ping" && opts.ping) reply(opts.ping());
      else if (d.method === "status") {
        if (opts.manual) replies.set(d.requestId, reply);
        else if (opts.status) reply(opts.status());
      }
    });
  };
  wire();
  return {
    bus, replies, wire,
    requests: (m: string) => bus.sent.filter((s) => s.channel === RPC_REQUEST_EVENT && s.data.method === m).map((s) => s.data),
  };
}
type Provider = ReturnType<typeof provider>;

function setup(p: Provider, session: () => unknown = () => SESSION) {
  let n = 0;
  const onChange = vi.fn();
  const m = createMonitor({
    events: p.bus,
    getSession: session as never,
    onChange,
    uuid: () => `req-${++n}`,
  });
  return { m, onChange };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("connection and load order", () => {
  it("synchronous ping + status replies; advertised events subscribed before first status", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData([node("run-1", "running", { startedAt: 1000 })]) });
    const order: string[] = [];
    const base = p;
    const inner = (p.bus as unknown as { emit: (c: string, d: unknown) => void }).emit;
    void inner;
    p.bus.setHook((c, d) => {
      if (c !== RPC_REQUEST_EVENT) return;
      order.push(`${d.method}:started-subs=${p.bus.count("subagent:async-started")}`);
      const data = d.method === "ping" ? pingData() : statusData([node("run-1", "running", { startedAt: 1000 })]);
      p.bus.emit(RPC_REPLY_PREFIX + d.requestId, { version: 1, requestId: d.requestId, success: true, data });
    });
    void base;
    const { m } = setup(p);
    m.start();
    expect(order).toEqual(["ping:started-subs=0", "status:started-subs=1"]);
    const s = m.snapshot();
    expect(s.state).toBe("ready");
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ category: "active", statusLabel: "running", task: "label run-1" });
    expect(s.diagnostics?.join(" ")).not.toContain("coverage pending");
    for (const name of Object.values(EVENTS).filter((n) => n.startsWith("subagent:"))) {
      expect(p.bus.count(name)).toBe(1);
    }
    m.dispose();
  });

  it("missing provider: ready/jobs-changed subscribed first, honest unavailable, later ready loads", () => {
    const p = provider(); // nobody answers ping
    const { m } = setup(p);
    m.start();
    expect(p.bus.count(RPC_READY_EVENT)).toBe(1);
    expect(p.bus.count(JOBS_CHANGED_EVENT)).toBe(1);
    expect(m.snapshot().state).toBe("connecting");
    vi.advanceTimersByTime(PING_TIMEOUT_MS);
    expect(m.snapshot()).toMatchObject({ state: "unavailable", records: [] });
    expect(m.snapshot().diagnostics?.[0]).toMatch(/not responding/);
    expect(vi.getTimerCount()).toBe(0);
    // provider loads later and announces ready
    p.bus.setHook((c, d) => {
      if (c === RPC_REQUEST_EVENT && d.method === "status") {
        p.bus.emit(RPC_REPLY_PREFIX + d.requestId, { version: 1, requestId: d.requestId, success: true, data: statusData([]) });
      }
    });
    p.bus.emit(RPC_READY_EVENT, pingData());
    expect(m.snapshot()).toMatchObject({ state: "ready", records: [] });
    m.dispose();
  });

  it("ignores ready/ping for another session and never shows other-session data", () => {
    const other = { sessionId: "other", sessionFile: "/o.jsonl" };
    const p = provider({ ping: () => pingData(other), status: () => statusData([node("x", "running")]) });
    const { m } = setup(p);
    m.start();
    expect(m.snapshot()).toMatchObject({ state: "unavailable", records: [] });
    expect(m.snapshot().diagnostics?.[0]).toMatch(/another session/);
    p.bus.emit(RPC_READY_EVENT, pingData(other));
    expect(p.requests("status")).toHaveLength(0);
    m.dispose();
  });

  it("rejects providers lacking status/version and reports unavailable honestly", () => {
    for (const bad of [{ version: 2 }, { methods: ["ping"] }, { capabilities: { status: false } }]) {
      const p = provider({ ping: () => pingData(SESSION, bad) });
      const { m } = setup(p);
      m.start();
      expect(m.snapshot().state).toBe("unavailable");
      expect(p.requests("status")).toHaveLength(0);
      m.dispose();
    }
  });

  it("ping error reply is unavailable, no crash", () => {
    const p = provider();
    p.bus.setHook((c, d) => {
      if (c === RPC_REQUEST_EVENT) {
        p.bus.emit(RPC_REPLY_PREFIX + d.requestId, { version: 1, requestId: d.requestId, success: false, error: { code: "unsupported_method", message: "x" } });
      }
    });
    const { m } = setup(p);
    m.start();
    expect(m.snapshot().diagnostics?.[0]).toMatch(/ping failed \(unsupported_method\)/);
    m.dispose();
  });

  it("only advertised, well-formed event names are subscribed", () => {
    const p = provider({
      ping: () => pingData(SESSION, { events: { ...EVENTS, jobsChanged: "evil\nname", asyncStarted: RPC_REQUEST_EVENT, childStatus: 5 } }),
      status: () => statusData([]),
    });
    const { m } = setup(p);
    m.start();
    expect(p.bus.count(RPC_REQUEST_EVENT)).toBe(0);
    expect(p.bus.count("subagent:child-status")).toBe(0);
    m.dispose();
  });
});

describe("coalescing, in-flight and dirty follow-up", () => {
  it("a burst of events yields one status read after ~250ms", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData([node("a", "running")]) });
    const { m } = setup(p);
    m.start();
    expect(p.requests("status")).toHaveLength(1);
    for (let i = 0; i < 20; i++) p.bus.emit(JOBS_CHANGED_EVENT, { version: 1 });
    p.bus.emit("subagent:async-complete", {});
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(p.requests("status")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(p.requests("status")).toHaveLength(2);
    m.dispose();
  });

  it("single in-flight request plus exactly one dirty follow-up, no polling", () => {
    const p = provider({ ping: () => pingData(), manual: true });
    const { m } = setup(p);
    m.start();
    expect(p.requests("status")).toHaveLength(1);
    p.bus.emit(JOBS_CHANGED_EVENT, {});
    p.bus.emit(JOBS_CHANGED_EVENT, {});
    vi.advanceTimersByTime(1000);
    expect(p.requests("status")).toHaveLength(1);
    p.replies.get("req-2")!(statusData([node("a", "running")]));
    expect(m.snapshot().records).toHaveLength(1);
    expect(p.requests("status")).toHaveLength(1);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(p.requests("status")).toHaveLength(2);
    p.replies.get("req-3")!(statusData([node("a", "complete")]));
    vi.advanceTimersByTime(60_000);
    expect(p.requests("status")).toHaveLength(2);
    expect(m.snapshot().records[0]).toMatchObject({ category: "success" });
    m.dispose();
  });

  it("status timeout keeps last safe records, flags problem, no retry loop", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData([node("a", "running")]) });
    const { m } = setup(p);
    m.start();
    p.bus.setHook(() => undefined); // provider goes silent
    p.bus.emit(JOBS_CHANGED_EVENT, {});
    vi.advanceTimersByTime(COALESCE_MS);
    expect(p.requests("status")).toHaveLength(2);
    vi.advanceTimersByTime(STATUS_TIMEOUT_MS);
    const s = m.snapshot();
    expect(s.records[0]).toMatchObject({ category: "active", statusLabel: "running" });
    expect(s.diagnostics?.[0]).toMatch(/timed out; showing last known/);
    vi.advanceTimersByTime(60_000);
    expect(p.requests("status")).toHaveLength(2);
    m.dispose();
  });

  it("late reply to a superseded request is ignored", () => {
    const p = provider({ ping: () => pingData(), manual: true });
    const { m } = setup(p);
    m.start();
    const late = p.replies.get("req-2")!;
    m.resetBranch(); // new generation: re-ping -> new status
    late(statusData([node("stale-from-old", "running")]));
    expect(m.snapshot().records).toHaveLength(0);
    p.replies.get("req-4")!(statusData([node("fresh", "running")]));
    expect(m.snapshot().records.map((r) => r.task)).toEqual(["label fresh"]);
    m.dispose();
  });

  it("session changed while status in flight: reply not applied, monitor rebinds", () => {
    let session = SESSION;
    const p = provider({ ping: () => pingData(session), manual: true });
    const { m } = setup(p, () => session);
    m.start();
    const reply = p.replies.get("req-2")!;
    session = { sessionId: "sess-2", sessionFile: "/s/2.jsonl" };
    reply(statusData([node("old", "running")]));
    expect(m.snapshot().records).toHaveLength(0);
    expect(p.requests("ping")).toHaveLength(2);
    m.dispose();
  });

  it("explicit refresh does not block and coalesces when bound", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData([]) });
    const { m } = setup(p);
    m.start();
    m.refresh();
    m.refresh();
    expect(p.requests("status")).toHaveLength(1);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(p.requests("status")).toHaveLength(2);
    m.dispose();
  });
});

describe("normalization", () => {
  const load = (runs: unknown[], fleet?: unknown) => {
    const p = provider({ ping: () => pingData(), status: () => statusData(runs, fleet) });
    const { m } = setup(p);
    m.start();
    return { p, m };
  };

  it("same-role concurrent runs stay separate, scoped by explicit ids", () => {
    const { m } = load([
      node("r1", "running", { children: [{ id: "step:0", kind: "step", label: "worker", agent: "worker", state: "running", model: "m1", startedAt: 5 }] }),
      node("r2", "running", { children: [{ id: "step:0", kind: "step", label: "worker", agent: "worker", state: "queued" }] }),
    ]);
    const recs = m.snapshot().records;
    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((r) => r.key)).size).toBe(2);
    expect(recs.map((r) => r.statusLabel).sort()).toEqual(["queued", "running"]);
    m.dispose();
  });

  it("containers suppressed, host-steps never rendered, no fleet rows", () => {
    const { m } = load([
      node("w1", "running", {
        kind: "workflow",
        children: [
          { id: "a", kind: "step", label: "A", agent: "scout", state: "running" },
          { id: "h", kind: "host-step", label: "host", state: "running", hostStep: { kind: "x", state: "running" } },
        ],
      }),
      node("w2", "running", { kind: "workflow", children: [{ id: "h", kind: "host-step", label: "h", state: "running" }] }),
    ], { version: 1, entries: [{ key: "fleet-1", agent: "x", startedAt: 1, tokens: {} }], totalActive: 3, omitted: 2 });
    const s = m.snapshot();
    // host-step never becomes an agent; host-only workflow is an aggregate "workflow" row
    expect(s.records.map((r) => r.agent).sort()).toEqual(["scout", "workflow"]);
    expect(s.records.some((r) => r.task === "h" || r.task === "host")).toBe(false);
    expect(s.fleet).toEqual({ active: 3, outside: 2 });
    expect(s.records.some((r) => r.key.includes("fleet-1"))).toBe(false);
    m.dispose();
  });

  it("status mapping never calls non-success completed; unknown is neutral", () => {
    const states = ["queued", "pending", "running", "complete", "failed", "rejected", "paused", "stopped", "partial", "weird"];
    const { m } = load(states.map((s, i) => node(`r${i}`, s)));
    const by = Object.fromEntries(m.snapshot().records.map((r) => [r.task, r]));
    expect(by["label r0"]).toMatchObject({ category: "active", statusLabel: "queued" });
    expect(by["label r1"]).toMatchObject({ category: "active", statusLabel: "queued" });
    expect(by["label r3"]).toMatchObject({ category: "success", statusLabel: "completed" });
    expect(by["label r5"]).toMatchObject({ category: "failed", statusLabel: "rejected" });
    for (const k of ["r6", "r7", "r8", "r9"]) expect(by[`label ${k}`]?.category).toBe("neutral");
    expect(by["label r9"]?.statusLabel).toBe("unknown");
    m.dispose();
  });

  it("duration only from a valid pair; no tokens/model invented", () => {
    const { m } = load([
      node("a", "complete", { startedAt: 1000, endedAt: 66_000 }),
      node("b", "complete", { startedAt: 1000 }),
      node("c", "failed", { startedAt: 9000, endedAt: 1000 }),
    ]);
    const by = Object.fromEntries(m.snapshot().records.map((r) => [r.task, r]));
    expect(by["label a"]?.duration).toBe("01:05");
    expect(by["label b"]).not.toHaveProperty("duration");
    expect(by["label c"]).not.toHaveProperty("duration");
    expect(by["label a"]).not.toHaveProperty("tokens");
    expect(by["label a"]).not.toHaveProperty("model");
    m.dispose();
  });

  it("malformed nodes/duplicates skipped with diagnostics, valid kept", () => {
    const { m } = load([
      node("ok", "running"),
      { kind: "subagent", state: "running" },
      "junk",
      node("dup", "running"),
      node("dup", "failed"),
      { ...node("badkind", "running"), kind: "mystery" },
    ]);
    const s = m.snapshot();
    expect(s.records.map((r) => r.task)).toEqual(["label ok"]);
    expect(s.diagnostics?.join(";")).toMatch(/malformed snapshot nodes skipped/);
    expect(s.diagnostics?.join(";")).toMatch(/duplicate snapshot identities/);
    m.dispose();
  });

  it("provider omission reported separately, never added to counts", () => {
    const p = provider({
      ping: () => pingData(),
      status: () => ({
        fleet: { version: 1, entries: [], totalActive: 9, omitted: 4 },
        asyncSnapshot: snapshot([node("a", "running")], { runs: 3, children: 2, byteLimitExceeded: true }),
      }),
    });
    const { m } = setup(p);
    m.start();
    const s = m.snapshot();
    expect(s.records).toHaveLength(1);
    expect(s.fleet).toEqual({ active: 9, outside: 4 });
    expect(s.diagnostics?.join(";")).toMatch(/provider projection omitted 3 runs, 2 children, byte limit hit/);
    const panel = renderPanel(s, true);
    expect(panel.rows[0]?.text).toBe("Known: 1 active");
    expect(panel.rows[1]?.text).toMatch(/Provider: 9 active; 4 outside fleet window/);
    m.dispose();
  });

  it("fleet-only reply: aggregate + identity-details-unavailable, no rows", () => {
    const p = provider({
      ping: () => pingData(SESSION, { capabilities: { status: true, fleetStatus: { version: 1 } } }),
      status: () => ({ fleet: { version: 1, entries: [{ key: "fleet-1" }], totalActive: 2, omitted: 0 } }),
    });
    const { m } = setup(p);
    m.start();
    const s = m.snapshot();
    expect(s.records).toEqual([]);
    expect(s.fleet).toEqual({ active: 2, outside: 0 });
    expect(s.diagnostics).toContain("Identity details unavailable");
    m.dispose();
  });

  it("malformed/omitted sources never erase the other source or last safe state", () => {
    let phase = 0;
    const p = provider({
      ping: () => pingData(),
      status: () => {
        phase += 1;
        if (phase === 1) return statusData([node("a", "running")]);
        if (phase === 2) return { fleet: { version: 1, totalActive: 1, omitted: 0 }, asyncSnapshot: { kind: "nope" } };
        if (phase === 3) return { fleet: "garbage", asyncSnapshot: snapshot([node("a", "running")]) };
        return "not an object";
      },
    });
    const { m } = setup(p);
    m.start();
    const tick = (): void => { p.bus.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(COALESCE_MS); };
    tick();
    expect(m.snapshot().records).toHaveLength(1);
    expect(m.snapshot().diagnostics?.join(";")).toMatch(/async snapshot malformed/);
    tick();
    expect(m.snapshot().records).toHaveLength(1);
    expect(m.snapshot().fleet).toEqual({ active: 1, outside: 0 });
    expect(m.snapshot().diagnostics?.join(";")).toMatch(/fleet counts malformed/);
    tick();
    expect(m.snapshot().records).toHaveLength(1);
    expect(m.snapshot().diagnostics?.[0]).toMatch(/malformed; showing last known/);
    m.dispose();
  });

  it("empty valid snapshot is authoritative-empty ready, not unavailable", () => {
    const { m } = load([]);
    expect(m.snapshot()).toMatchObject({ state: "ready", records: [] });
    m.dispose();
  });

  it("non-active history bounded to 100 (newest kept), active never evicted", () => {
    const runs = [
      ...Array.from({ length: MAX_NON_ACTIVE + 30 }, (_, i) => node(`d${i}`, "complete", { endedAt: 1000 + i })),
      node("live", "running"),
    ];
    const { m } = load(runs);
    const s = m.snapshot();
    // local input bound is 100 runs: only the first 100 inspected, honestly reported
    expect(s.diagnostics?.join(";")).toMatch(/bounded locally/);
    expect(s.records.filter((r) => r.category !== "active").length).toBeLessThanOrEqual(MAX_NON_ACTIVE);
    m.dispose();
  });

  it("accumulated history across reads is capped at 100 non-active; active kept", () => {
    let batch = 0;
    const p = provider({
      ping: () => pingData(),
      status: () => {
        const base = batch * 60;
        batch += 1;
        return statusData([
          ...Array.from({ length: 60 }, (_, i) => node(`d${base + i}`, "complete", { endedAt: 1000 + base + i })),
          node("live", "running"),
        ]);
      },
    });
    const { m } = setup(p);
    m.start();
    for (let i = 0; i < 2; i++) { p.bus.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(COALESCE_MS); }
    const s = m.snapshot();
    expect(s.records.filter((r) => r.category === "active")).toHaveLength(1);
    expect(s.records.filter((r) => r.category !== "active")).toHaveLength(MAX_NON_ACTIVE);
    expect(s.historyLimited).toBe(true);
    expect(s.records.some((r) => r.task === "label d179")).toBe(true);
    expect(s.records.some((r) => r.task === "label d0")).toBe(false);
    m.dispose();
  });

  it("never discards active records: >1000 distinct reported across valid snapshots are all retained", () => {
    let batch = 0;
    const p = provider({
      ping: () => pingData(),
      status: () => {
        const base = batch * 100;
        batch += 1;
        return statusData(Array.from({ length: 100 }, (_, i) => node(`a${base + i}`, "running")));
      },
    });
    const { m } = setup(p);
    m.start();
    for (let i = 0; i < 11; i++) { p.bus.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(COALESCE_MS); }
    const s = m.snapshot();
    expect(s.records.filter((r) => r.category === "active")).toHaveLength(1200);
    expect(s.diagnostics?.join(";")).not.toMatch(/safety cap/);
    m.dispose();
  });

  it("oversize input is bounded without unbounded traversal", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData(Array.from({ length: 5000 }, (_, i) => node(`r${i}`, "running"))) });
    const { m } = setup(p);
    m.start();
    const s = m.snapshot();
    expect(s.records.length).toBeLessThanOrEqual(100);
    expect(s.diagnostics?.join(";")).toMatch(/bounded locally/);
    m.dispose();
  });
});

describe("terminal monotonicity and disappearance", () => {
  function sequence(replies: unknown[]) {
    let i = 0;
    const p = provider({ ping: () => pingData(), status: () => replies[Math.min(i++, replies.length - 1)] });
    const { m } = setup(p);
    m.start();
    const tick = (): void => { p.bus.emit(JOBS_CHANGED_EVENT, {}); vi.advanceTimersByTime(COALESCE_MS); };
    return { m, tick, p };
  }

  it("vanished active record is kept stale, NOT completed; later terminal evidence resolves it", () => {
    const { m, tick } = sequence([
      statusData([node("a", "running", { startedAt: 1 })]),
      statusData([]),
      statusData([node("a", "complete", { startedAt: 1, endedAt: 5001 })]),
    ]);
    expect(m.snapshot().records[0]).toMatchObject({ category: "active", statusLabel: "running" });
    tick();
    let s = m.snapshot();
    expect(s.records).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ category: "active", statusLabel: "running (stale)" });
    expect(s.diagnostics).toContain("1 active not in latest projection");
    tick();
    s = m.snapshot();
    expect(s.records[0]).toMatchObject({ category: "success", statusLabel: "completed", duration: "00:05" });
    m.dispose();
  });

  it("terminal never regresses from a late/older snapshot; conflicts diagnosed", () => {
    const { m, tick } = sequence([
      statusData([node("a", "failed", { endedAt: 10 })]),
      statusData([node("a", "running")]),
      statusData([node("a", "complete")]),
    ]);
    expect(m.snapshot().records[0]).toMatchObject({ category: "failed" });
    tick();
    expect(m.snapshot().records[0]).toMatchObject({ category: "failed" });
    tick();
    expect(m.snapshot().records[0]).toMatchObject({ category: "failed" });
    expect(m.snapshot().diagnostics?.join(";")).toMatch(/conflicting terminal reports ignored/);
    m.dispose();
  });

  it("terminal record disappearing from projection stays once, not duplicated", () => {
    const { m, tick } = sequence([statusData([node("a", "complete")]), statusData([])]);
    tick();
    expect(m.snapshot().records).toHaveLength(1);
    expect(m.snapshot().records[0]?.category).toBe("success");
    m.dispose();
  });

  it("paused may resume to running (non-final)", () => {
    const { m, tick } = sequence([statusData([node("a", "paused")]), statusData([node("a", "running")])]);
    expect(m.snapshot().records[0]?.category).toBe("neutral");
    tick();
    expect(m.snapshot().records[0]?.category).toBe("active");
    m.dispose();
  });
});

describe("disposal", () => {
  it("removes listeners/timers, ignores late replies, no further requests or changes", () => {
    const p = provider({ ping: () => pingData(), manual: true });
    const { m, onChange } = setup(p);
    m.start();
    p.bus.emit(JOBS_CHANGED_EVENT, {});
    const reply = p.replies.get("req-2")!;
    m.dispose();
    m.dispose();
    expect(p.bus.total()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const sent = p.bus.sent.length;
    const calls = onChange.mock.calls.length;
    reply(statusData([node("a", "running")]));
    p.bus.emit(JOBS_CHANGED_EVENT, {});
    p.bus.emit(RPC_READY_EVENT, pingData());
    m.refresh();
    m.resetBranch();
    vi.advanceTimersByTime(10_000);
    // only the events/reply emitted by this test itself
    expect(p.bus.sent.length).toBe(sent + 3);
    expect(p.requests("status")).toHaveLength(1);
    expect(p.requests("ping")).toHaveLength(1);
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it("dispose during pending ping clears the timeout", () => {
    const p = provider();
    const { m } = setup(p);
    m.start();
    expect(vi.getTimerCount()).toBe(1);
    m.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(p.bus.total()).toBe(0);
  });

  it("a replacement monitor on the same bus starts clean", () => {
    const p = provider({ ping: () => pingData(), status: () => statusData([node("a", "running")]) });
    const a = setup(p).m;
    a.start();
    a.dispose();
    expect(p.bus.total()).toBe(0);
    const b = setup(p).m;
    b.start();
    expect(b.snapshot().records).toHaveLength(1);
    b.dispose();
    expect(p.bus.total()).toBe(0);
  });
});
