/**
 * Identity-rich BACKGROUND monitor for pi-subagents.
 *
 * Talks to the provider only through the public `subagents:rpc:v1:*` event
 * bus contract (ping / status), validates every payload at the boundary and
 * exposes a bounded snapshot. It never mutates executions, never polls, and
 * never renders opaque fleet entries or infers identity: only structured
 * async-status-snapshot nodes with explicit scoped IDs become records. Fleet
 * aggregate counts are kept separate and non-additive.
 *
 * Foreground tool progress and branch history are NOT covered yet; the
 * snapshot says so explicitly.
 */
import type { EventTransport, MonitorSnapshot, RecordCategory, SnapshotRecord } from "./types.ts";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const JOBS_CHANGED_EVENT = "subagent:jobs-changed";

export const COALESCE_MS = 250;
export const PING_TIMEOUT_MS = 2_000;
export const STATUS_TIMEOUT_MS = 5_000;
export const MAX_NON_ACTIVE = 100;
const MAX_RUNS = 100;
const MAX_CHILDREN = 64;
const MAX_DEPTH = 6;
const MAX_NODES = 600;
const MAX_ID_CHARS = 256;
const MAX_RAW_TEXT = 512;

export interface MonitorSession {
  sessionId: string;
  sessionFile?: string | null;
}

export interface MonitorOptions {
  events: EventTransport;
  /** Reads the live session identity; may throw when the context is stale. */
  getSession: () => MonitorSession | undefined;
  /** Called after any snapshot-relevant change (never after dispose). */
  onChange?: () => void;
  uuid?: () => string;
}

export interface Monitor {
  /** Subscribe, then ping. Idempotent. */
  start(): void;
  snapshot(): MonitorSnapshot;
  /** Explicit refresh/reconnect (e.g. user command); never blocks the caller. */
  refresh(): void;
  /** Same session, new branch: drop pending work and re-read. */
  resetBranch(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Boundary validation helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const rawText = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.slice(0, MAX_RAW_TEXT) : undefined;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const safeId = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS && v.trim() !== "" && !CONTROL.test(v)
    ? v
    : undefined;
const EVENT_NAME = /^subagents?:[\w.:-]{1,100}$/;
const isSafeEventName = (v: unknown): v is string =>
  typeof v === "string" && EVENT_NAME.test(v) &&
  !v.startsWith(RPC_REQUEST_EVENT) && !v.startsWith(RPC_REPLY_PREFIX);

const sameFile = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null);

// ---------------------------------------------------------------------------
// Ping validation
// ---------------------------------------------------------------------------

interface ProviderInfo {
  fleet: boolean;
  snapshot: boolean;
  events: { name: string; ready: boolean }[];
}

type PingResult =
  | { ok: true; info: ProviderInfo }
  | { ok: false; reason: string; mismatch?: boolean };

const ADVERTISED_EVENTS = ["ready", "jobsChanged", "asyncStarted", "childStatus", "asyncComplete", "processTerminal"] as const;

/** Validates a ping reply or ready payload (same shape) against the current session. */
function validatePing(data: unknown, session: MonitorSession | undefined): PingResult {
  if (!isRec(data)) return { ok: false, reason: "provider ping malformed" };
  if (data.version !== 1) return { ok: false, reason: "provider protocol version unsupported" };
  if (!Array.isArray(data.methods) || !data.methods.includes("status")) {
    return { ok: false, reason: "provider lacks status RPC" };
  }
  const caps = isRec(data.capabilities) ? data.capabilities : {};
  if (caps.status !== true) return { ok: false, reason: "provider lacks status capability" };
  const s = isRec(data.session) ? data.session : undefined;
  const sid = safeId(s?.sessionId);
  if (!session || !sid) return { ok: false, reason: "provider session identity unavailable", mismatch: true };
  const file = s?.sessionFile;
  const fileOk = file === null || file === undefined || typeof file === "string";
  if (sid !== session.sessionId || !fileOk || !sameFile(file as string | null | undefined, session.sessionFile)) {
    return { ok: false, reason: "provider bound to another session", mismatch: true };
  }
  const snap = caps.asyncStatusSnapshot;
  const fleet = caps.fleetStatus;
  const events: ProviderInfo["events"] = [];
  const advertised = isRec(data.events) ? data.events : {};
  for (const key of ADVERTISED_EVENTS) {
    const name = advertised[key];
    if (isSafeEventName(name) && !events.some((e) => e.name === name)) events.push({ name, ready: key === "ready" });
  }
  return {
    ok: true,
    info: {
      fleet: isRec(fleet) && fleet.version === 1,
      snapshot: isRec(snap) && snap.kind === SNAPSHOT_KIND && snap.version === 1,
      events,
    },
  };
}

// ---------------------------------------------------------------------------
// Async snapshot normalization (explicit scoped identity only)
// ---------------------------------------------------------------------------

const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";

type Status = "queued" | "running" | "completed" | "failed" | "rejected" | "paused" | "stopped" | "partial" | "unknown";

const STATE_MAP: Record<string, Status> = {
  queued: "queued", pending: "queued", running: "running",
  complete: "completed", completed: "completed",
  failed: "failed", error: "failed", rejected: "rejected",
  paused: "paused", stopped: "stopped", partial: "partial",
};
const CATEGORY: Record<Status, RecordCategory> = {
  queued: "active", running: "active", completed: "success",
  failed: "failed", rejected: "failed",
  paused: "neutral", stopped: "neutral", partial: "neutral", unknown: "neutral",
};
/** Terminal for monotonicity. `paused` may legitimately resume; `unknown` is not evidence. */
const FINAL = new Set<Status>(["completed", "failed", "rejected", "stopped", "partial"]);

interface Tracked {
  key: string;
  path: string[];
  status: Status;
  task?: string;
  agent?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  sortTime?: number;
  stale: boolean;
}

interface Normalized {
  records: Map<string, Tracked>;
  notes: string[];
}

function normalizeSnapshot(raw: unknown): Normalized | undefined {
  if (!isRec(raw) || raw.kind !== SNAPSHOT_KIND || raw.version !== 1 || !Array.isArray(raw.runs)) return undefined;
  const notes: string[] = [];
  const records = new Map<string, Tracked>();
  const conflicts: string[][] = [];
  let skipped = 0;
  let visited = 0;
  let bounded = false;

  const keyOf = (path: string[]): string => `async:${JSON.stringify(path)}`;

  const walk = (node: unknown, parent: string[], depth: number): void => {
    if (visited >= MAX_NODES || depth > MAX_DEPTH) { bounded = true; return; }
    visited += 1;
    if (!isRec(node)) { skipped += 1; return; }
    const id = safeId(node.id);
    const kind = node.kind;
    if (!id || (kind !== "subagent" && kind !== "workflow" && kind !== "step" && kind !== "host-step")) {
      skipped += 1;
      return;
    }
    // Host work is orchestration, not a subagent: never counted or rendered.
    if (kind === "host-step") return;
    const path = [...parent, `${kind}:${id}`];
    const key = keyOf(path);
    if (records.has(key) || conflicts.some((c) => c.length === path.length && c.every((p, i) => p === path[i]))) {
      conflicts.push(path);
      return;
    }

    const rawChildren = Array.isArray(node.children) ? node.children : [];
    if (rawChildren.length > MAX_CHILDREN) bounded = true;
    const children = rawChildren.slice(0, MAX_CHILDREN).filter((c) => !(isRec(c) && c.kind === "host-step"));
    const agent = rawText(node.agent);
    const label = rawText(node.label);
    // A step with an agent is itself an execution; other containers are
    // suppressed when ordinary children represent the executions.
    const represents = kind === "step" ? agent !== undefined || children.length === 0 : children.length === 0;

    if (represents) {
      const status = typeof node.state === "string" ? STATE_MAP[node.state] ?? "unknown" : "unknown";
      const startedAt = nonNegInt(node.startedAt);
      const endedAt = nonNegInt(node.endedAt);
      const updatedAt = nonNegInt(node.updatedAt);
      const t: Tracked = {
        key, path, status, stale: false,
        ...(label ? { task: label } : {}),
        ...(agent && agent !== label ? { agent } : kind === "workflow" ? { agent: "workflow" } : {}),
        ...(rawText(node.model) ? { model: rawText(node.model)! } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
      };
      const sortTime = endedAt ?? updatedAt ?? startedAt;
      if (sortTime !== undefined) t.sortTime = sortTime;
      records.set(key, t);
    }
    for (const child of children) walk(child, path, depth + 1);
  };

  const runs = raw.runs;
  if (runs.length > MAX_RUNS) bounded = true;
  for (const run of runs.slice(0, MAX_RUNS)) walk(run, [], 0);

  if (conflicts.length) {
    const underConflict = (p: string[]): boolean =>
      conflicts.some((c) => c.length <= p.length && c.every((s, i) => s === p[i]));
    for (const [k, t] of records) if (underConflict(t.path)) records.delete(k);
    notes.push(`${conflicts.length} duplicate snapshot identities skipped`);
  }
  if (skipped) notes.push(`${skipped} malformed snapshot nodes skipped`);
  if (bounded) notes.push("snapshot read bounded locally");

  const omitted = isRec(raw.omitted) ? raw.omitted : undefined;
  const oRuns = nonNegInt(omitted?.runs);
  const oChildren = nonNegInt(omitted?.children);
  const trunc: string[] = [];
  if (oRuns) trunc.push(`${oRuns} runs`);
  if (oChildren) trunc.push(`${oChildren} children`);
  if (omitted?.byteLimitExceeded === true) trunc.push("byte limit hit");
  if (trunc.length) notes.push(`provider projection omitted ${trunc.join(", ")}`);
  if (!omitted || (omitted.runs !== undefined && oRuns === undefined) || (omitted.children !== undefined && oChildren === undefined)) {
    notes.push("projection coverage counts unavailable");
  }
  return { records, notes };
}

interface FleetCounts { active?: number; outside?: number }

function normalizeFleet(raw: unknown): FleetCounts | undefined {
  if (!isRec(raw) || raw.version !== 1) return undefined;
  const active = nonNegInt(raw.totalActive);
  const outside = nonNegInt(raw.omitted);
  if (active === undefined && outside === undefined) return undefined;
  return { ...(active !== undefined ? { active } : {}), ...(outside !== undefined ? { outside } : {}) };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatDuration(startedAt: number | undefined, endedAt: number | undefined): string | undefined {
  if (startedAt === undefined || endedAt === undefined || endedAt < startedAt) return undefined;
  const total = Math.floor((endedAt - startedAt) / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

const byRecency = (a: Tracked, b: Tracked): number => {
  if (a.sortTime !== undefined && b.sortTime !== undefined && a.sortTime !== b.sortTime) return b.sortTime - a.sortTime;
  if ((a.sortTime === undefined) !== (b.sortTime === undefined)) return a.sortTime === undefined ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
};

// ---------------------------------------------------------------------------
// RPC request helper (listener registered BEFORE emit; sync replies safe)
// ---------------------------------------------------------------------------

type RpcResult = { kind: "ok"; data: unknown } | { kind: "error"; code: string } | { kind: "timeout" };

function rpcRequest(
  events: EventTransport,
  requestId: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  done: (result: RpcResult) => void,
): () => void {
  let finished = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = (): void => {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const u = unsubscribe;
    unsubscribe = undefined;
    u?.();
  };
  const finish = (result: RpcResult): void => {
    if (finished) return;
    cleanup();
    done(result);
  };
  try {
    unsubscribe = events.on(RPC_REPLY_PREFIX + requestId, (reply) => {
      if (finished) return;
      if (!isRec(reply) || reply.version !== 1 || reply.requestId !== requestId) return;
      if (reply.success === true) return finish({ kind: "ok", data: reply.data });
      if (reply.success === false) {
        const code = isRec(reply.error) && typeof reply.error.code === "string" ? reply.error.code.slice(0, 40) : "error";
        return finish({ kind: "error", code: code.replace(CONTROL, " ") });
      }
    });
    if (finished) { cleanup(); return () => undefined; }
    events.emit(RPC_REQUEST_EVENT, { version: 1, requestId, method, params });
  } catch {
    finish({ kind: "error", code: "bus" });
    return () => undefined;
  }
  if (!finished) {
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  }
  return cleanup;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

type Link = "idle" | "connecting" | "bound" | "down";

export function createMonitor(options: MonitorOptions): Monitor {
  const { events } = options;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());

  let disposed = false;
  let started = false;
  let generation = 0;
  let link: Link = "idle";
  let problem: string | undefined;
  let loaded = false;
  let info: ProviderInfo = { fleet: false, snapshot: false, events: [] };

  let tracked = new Map<string, Tracked>();
  let fleet: FleetCounts | undefined;
  let notes: string[] = [];
  let historyLimited = false;

  let dirty = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let pingToken: object | undefined;
  let statusToken: object | undefined;
  let cancelPing: (() => void) | undefined;
  let cancelStatus: (() => void) | undefined;
  const subs = new Map<string, () => void>();

  const changed = (): void => {
    if (disposed) return;
    try { options.onChange?.(); } catch { /* presentation errors must not break the monitor */ }
  };
  const currentSession = (): MonitorSession | undefined => {
    try { return options.getSession(); } catch { return undefined; }
  };
  const sameSession = (a: MonitorSession | undefined, b: MonitorSession | undefined): boolean =>
    !!a && !!b && a.sessionId === b.sessionId && sameFile(a.sessionFile, b.sessionFile);

  const clearCoalesce = (): void => {
    if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
  };
  const cancelInflight = (): void => {
    generation += 1;
    clearCoalesce();
    dirty = false;
    pingToken = undefined;
    statusToken = undefined;
    const p = cancelPing, s = cancelStatus;
    cancelPing = cancelStatus = undefined;
    p?.();
    s?.();
  };

  // -- status flow ---------------------------------------------------------

  const scheduleStatus = (): void => {
    if (disposed || link !== "bound") return;
    if (statusToken) { dirty = true; return; }
    if (coalesceTimer !== undefined) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      loadStatus();
    }, COALESCE_MS);
    (coalesceTimer as { unref?: () => void }).unref?.();
  };

  const loadStatus = (): void => {
    if (disposed || link !== "bound" || statusToken) return;
    const session = currentSession();
    if (!session) { fail("session identity unavailable"); return; }
    const gen = generation;
    const token = {};
    statusToken = token;
    dirty = false;
    const cancel = rpcRequest(events, uuid(), "status", {}, STATUS_TIMEOUT_MS, (result) => {
      if (statusToken !== token || gen !== generation || disposed) return;
      statusToken = undefined;
      cancelStatus = undefined;
      if (!sameSession(session, currentSession())) { connect(); return; } // rebind, never apply
      if (result.kind === "timeout") { fail("status timed out; showing last known state"); return; }
      if (result.kind === "error") { fail(`status failed (${result.code}); showing last known state`); return; }
      applyStatus(result.data);
      if (dirty) { dirty = false; scheduleStatus(); }
    });
    if (statusToken === token) cancelStatus = cancel;
  };

  /** Keep last safe records; mark the provider problem. No automatic retry. */
  const fail = (reason: string): void => {
    problem = reason;
    dirty = false;
    changed();
  };

  const applyStatus = (data: unknown): void => {
    if (!isRec(data)) { fail("status reply malformed; showing last known state"); return; }
    const nextNotes: string[] = [];
    let usable = false;

    let nextFleet = fleet;
    if (data.fleet !== undefined) {
      const f = normalizeFleet(data.fleet);
      if (f) { nextFleet = f; usable = true; } else nextNotes.push("fleet counts malformed");
    } else if (info.fleet) {
      nextNotes.push("fleet counts missing from reply");
    }

    if (data.asyncSnapshot !== undefined) {
      const snap = normalizeSnapshot(data.asyncSnapshot);
      if (snap) {
        usable = true;
        nextNotes.push(...snap.notes);
        reconcile(snap.records, nextNotes);
      } else {
        nextNotes.push("async snapshot malformed; showing last known records");
      }
    } else {
      nextNotes.push(info.snapshot ? "async snapshot missing from reply; showing last known records" : "Identity details unavailable");
    }

    if (!usable) { fail("status reply had no usable data; showing last known state"); return; }
    fleet = nextFleet;
    notes = nextNotes;
    loaded = true;
    problem = undefined;
    changed();
  };

  /** Merge an authoritative snapshot: terminal is monotonic, absence is stale not done. */
  const reconcile = (incoming: Map<string, Tracked>, outNotes: string[]): void => {
    let conflicting = 0;
    for (const [key, next] of incoming) {
      const prev = tracked.get(key);
      if (prev && FINAL.has(prev.status)) {
        if (next.status !== prev.status && FINAL.has(next.status)) conflicting += 1;
        continue; // terminal never regresses and is not reinterpreted
      }
      tracked.set(key, next);
    }
    for (const [key, prev] of tracked) {
      if (!incoming.has(key) && CATEGORY[prev.status] === "active") prev.stale = true;
    }
    if (conflicting) outNotes.push(`${conflicting} conflicting terminal reports ignored`);
    prune();
  };

  const prune = (): void => {
    const inactive = [...tracked.values()].filter((t) => CATEGORY[t.status] !== "active").sort(byRecency);
    if (inactive.length <= MAX_NON_ACTIVE) return;
    for (const t of inactive.slice(MAX_NON_ACTIVE)) tracked.delete(t.key);
    historyLimited = true;
  };

  // -- connection flow -----------------------------------------------------

  const subscribeAdvertised = (): void => {
    const wanted = new Map(info.events.map((e) => [e.name, e.ready] as const));
    for (const [name, unsub] of subs) {
      if (!wanted.has(name) && !isStatic(name)) { subs.delete(name); unsub(); }
    }
    for (const [name, ready] of wanted) if (!subs.has(name)) subs.set(name, listen(name, ready));
  };
  const isStatic = (name: string): boolean => name === RPC_READY_EVENT || name === JOBS_CHANGED_EVENT;

  const listen = (name: string, ready: boolean): (() => void) =>
    events.on(name, (payload) => {
      if (disposed) return;
      try { ready ? onReady(payload) : onInvalidate(); } catch { /* ignore handler faults */ }
    });

  const onInvalidate = (): void => {
    if (link === "bound") scheduleStatus();
    else if (link === "down") connect(); // a documented change signal may mean the provider is back
  };

  const onReady = (payload: unknown): void => {
    const result = validatePing(payload, currentSession());
    if (!result.ok) return; // other session / not ours: wait for the right ready or an explicit refresh
    bind(result.info);
  };

  const connect = (): void => {
    if (disposed || !started) return;
    cancelInflight();
    link = "connecting";
    const session = currentSession();
    const gen = generation;
    const token = {};
    pingToken = token;
    const cancel = rpcRequest(events, uuid(), "ping", {}, PING_TIMEOUT_MS, (result) => {
      if (pingToken !== token || gen !== generation || disposed) return;
      pingToken = undefined;
      cancelPing = undefined;
      if (result.kind === "timeout") return down("subagent provider not responding");
      if (result.kind === "error") return down(`subagent provider ping failed (${result.code})`);
      const checked = validatePing(result.data, session);
      if (!checked.ok) return down(checked.reason);
      if (!sameSession(session, currentSession())) return;
      bind(checked.info);
    });
    if (pingToken === token) cancelPing = cancel;
  };

  const down = (reason: string): void => {
    link = "down";
    problem = reason;
    changed();
  };

  /** Provider is validated for the current session: subscribe first, then read. */
  const bind = (next: ProviderInfo): void => {
    if (disposed) return;
    cancelInflight();
    info = next;
    link = "bound";
    problem = undefined;
    subscribeAdvertised();
    loadStatus();
  };

  // -- public --------------------------------------------------------------

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      // Known names first, so nothing is missed between ping and status.
      subs.set(RPC_READY_EVENT, listen(RPC_READY_EVENT, true));
      subs.set(JOBS_CHANGED_EVENT, listen(JOBS_CHANGED_EVENT, false));
      connect();
    },

    snapshot(): MonitorSnapshot {
      if (!loaded) {
        return {
          state: link === "down" ? "unavailable" : started ? "connecting" : "pending",
          records: [],
          ...(problem ? { diagnostics: [problem] } : {}),
        };
      }
      const list = [...tracked.values()].sort(byRecency);
      let stale = 0;
      const records: SnapshotRecord[] = list.map((t) => {
        if (t.stale) stale += 1;
        const duration = CATEGORY[t.status] === "active" ? undefined : formatDuration(t.startedAt, t.endedAt);
        return {
          key: t.key,
          category: CATEGORY[t.status],
          statusLabel: t.stale ? `${t.status} (stale)` : t.status,
          ...(t.task ? { task: t.task } : {}),
          ...(t.agent ? { agent: t.agent } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(duration ? { duration } : {}),
        };
      });
      const diagnostics = [
        ...(problem ? [problem] : []),
        ...(stale ? [`${stale} active not in latest projection`] : []),
        ...notes,
        "foreground/history coverage pending",
      ];
      return {
        state: "ready",
        records,
        ...(fleet ? { fleet } : {}),
        diagnostics,
        ...(historyLimited ? { historyLimited: true } : {}),
      };
    },

    refresh(): void {
      if (disposed || !started) return;
      if (link === "bound" && loaded) scheduleStatus();
      else if (link !== "connecting") connect();
    },

    resetBranch(): void {
      if (disposed || !started) return;
      connect();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelInflight();
      for (const unsub of subs.values()) unsub();
      subs.clear();
      tracked = new Map();
    },
  };
}
