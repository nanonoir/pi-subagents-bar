/**
 * Identity-rich monitor for pi-subagents.
 *
 * Talks to the provider only through the public `subagents:rpc:v1:*` event
 * bus contract (ping / status), validates every payload at the boundary and
 * exposes a bounded snapshot. It never mutates executions, never polls, and
 * never renders opaque fleet entries or infers identity: only structured
 * async-status-snapshot nodes with explicit scoped IDs become records. Fleet
 * aggregate counts are kept separate and non-additive.
 *
 * Foreground tool results and current-branch history use indexed identities.
 * Structured notices, elapsed display updates and optional cost enrichment are session-scoped.
 */
import type { EventTransport, MonitorSnapshot, RecordCategory, SnapshotRecord } from "./types.ts";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const JOBS_CHANGED_EVENT = "subagent:jobs-changed";

export const COALESCE_MS = 250;
export const PING_TIMEOUT_MS = 2_000;
export const STATUS_TIMEOUT_MS = 5_000;
export const COST_TIMEOUT_MS = 5_000;
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
  getBranch?: () => readonly unknown[];
  /** Called after any snapshot-relevant change (never after dispose). */
  onChange?: () => void;
  uuid?: () => string;
  now?: () => number;
}

export interface Monitor {
  /** Subscribe, then ping. Idempotent. */
  start(): void;
  snapshot(): MonitorSnapshot;
  /** Explicit refresh/reconnect (e.g. user command); never blocks the caller. */
  refresh(): void;
  /** Same session, new branch: drop pending work and re-read. */
  resetBranch(): void;
  observeTool(toolCallId: unknown, result: unknown, final: boolean): void;
  observeMessage(message: unknown): void;
  agentSettled(): void;
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
  cost: boolean;
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
      cost: data.methods.includes("cost") && isRec(caps.cost) && caps.cost.version === 1,
      events,
    },
  };
}

// ---------------------------------------------------------------------------
// Async snapshot normalization (explicit scoped identity only)
// ---------------------------------------------------------------------------

const SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";

type Status = "queued" | "running" | "completed" | "failed" | "rejected" | "paused" | "stopped" | "partial" | "cancelled" | "interrupted" | "detached" | "unknown";

const STATE_MAP: Record<string, Status> = {
  queued: "queued", pending: "queued", running: "running",
  complete: "completed", completed: "completed",
  failed: "failed", error: "failed", rejected: "rejected",
  paused: "paused", stopped: "stopped", partial: "partial", cancelled: "cancelled", interrupted: "interrupted", detached: "detached",
};
const CATEGORY: Record<Status, RecordCategory> = {
  queued: "active", running: "active", completed: "success",
  failed: "failed", rejected: "failed",
  paused: "neutral", stopped: "neutral", partial: "neutral", cancelled: "neutral", interrupted: "neutral", detached: "neutral", unknown: "neutral",
};
/** Terminal for monotonicity. `paused` may legitimately resume; `unknown` is not evidence. */
const FINAL = new Set<Status>(["completed", "failed", "rejected", "stopped", "partial", "cancelled", "interrupted"]);

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
  parentId?: string;
  durationMs?: number;
  observedAt?: number;
  childId?: string;
  singleParent?: boolean;
  workflowKey?: string;
  noticeSource?: string;
  tokens?: string;
  authority?: number;
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
      const rootId = parent.length ? parent[0]?.slice(parent[0].indexOf(":") + 1) : id;
      const t: Tracked = {
        key, path, status, stale: false, ...(rootId ? { parentId: rootId } : {}),
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

function formatDuration(startedAt: number | undefined, endedAt: number | undefined, durationMs?: number): string | undefined {
  const ms = durationMs ?? (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt ? endedAt - startedAt : undefined);
  if (ms === undefined) return undefined;
  const total = Math.floor(ms / 1000);
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
  const now = options.now ?? Date.now;

  let disposed = false;
  let started = false;
  let generation = 0;
  let link: Link = "idle";
  let problem: string | undefined;
  let loaded = false;
  let info: ProviderInfo = { fleet: false, snapshot: false, cost: false, events: [] };

  let tracked = new Map<string, Tracked>();
  let foreground = new Map<string, Tracked>();
  let notices = new Map<string, Tracked>();
  const costUsage = new Map<string, { id: string; tokens: string }>();
  let callParents = new Map<string, string>();
  let retiredCalls = new Set<string>();
  let foregroundNotes: string[] = [];
  let boundSession: MonitorSession | undefined;
  let rebuilding = false;
  let fleet: FleetCounts | undefined;
  let notes: string[] = [];
  let historyLimited = false;

  let dirty = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let elapsedTimer: ReturnType<typeof setTimeout> | undefined;
  let costTimer: ReturnType<typeof setTimeout> | undefined;
  let costToken: object | undefined;
  let costDirty = false;
  let costDue = false;
  let cancelCost: (() => void) | undefined;
  let pingToken: object | undefined;
  let statusToken: object | undefined;
  let cancelPing: (() => void) | undefined;
  let cancelStatus: (() => void) | undefined;
  const subs = new Map<string, () => void>();

  const changed = (): void => {
    if (disposed) return;
    clearElapsed();
    scheduleElapsed();
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
    if (costToken || costTimer !== undefined || costDirty) costDue = true;
    costToken = undefined;
    costDirty = false;
    if (costTimer !== undefined) clearTimeout(costTimer);
    costTimer = undefined;
    const p = cancelPing, s = cancelStatus, c = cancelCost;
    cancelPing = cancelStatus = cancelCost = undefined;
    p?.();
    s?.();
    c?.();
  };

  const selected = (): Tracked[] => {
    const fgParents = new Set([...foreground.values()].map((t) => t.parentId).filter((v): v is string => !!v));
    const childrenParents = new Set([...notices.values()].filter((t) => t.childId || t.workflowKey).map((t) => t.parentId!));
    const asyncRows = [...tracked.values()].filter((t) => !t.parentId || (!fgParents.has(t.parentId) && !childrenParents.has(t.parentId)));
    const noticeRows = [...notices.values()].filter((t) => {
      if (!t.parentId || fgParents.has(t.parentId)) return false;
      if (t.childId || t.workflowKey) return true;
      if (childrenParents.has(t.parentId)) return false;
      const same = asyncRows.filter((a) => a.parentId === t.parentId);
      return same.length === 0 || (t.noticeSource !== "foreground" && t.status !== "unknown" && same.length === 1 && same[0]?.path.length === 1);
    });
    const aggregateParents = new Set(noticeRows.filter((t) => !t.childId && !t.workflowKey).map((t) => t.parentId));
    const mergedNotices = noticeRows.map((t) => {
      if (t.childId || t.workflowKey) return t;
      const root = asyncRows.find((a) => a.parentId === t.parentId && a.path.length === 1);
      return root ? { ...root, ...t, task: t.task ?? root.task, model: t.model ?? root.model } as Tracked : t;
    });
    const fgRows = [...foreground.values()];
    const noticeChildren = [...notices.values()].filter((t) => t.childId || t.workflowKey);
    const aliasesMatch = (f: Tracked, n: Tracked): boolean => f.parentId === n.parentId &&
      ((!!f.childId && f.childId === n.childId) || (!!f.workflowKey && f.workflowKey === n.workflowKey)) &&
      !(f.childId && n.childId && f.childId !== n.childId) &&
      !(f.workflowKey && n.workflowKey && f.workflowKey !== n.workflowKey);
    const mergedForeground = fgRows.map((f) => {
      if (f.authority === 2 && f.status !== "detached") return f;
      const matches = noticeChildren.filter((n) => aliasesMatch(f, n));
      if (matches.length !== 1 || fgRows.filter((other) => aliasesMatch(other, matches[0]!)).length !== 1) return f;
      const n = matches[0]!;
      const fill = {
        ...(!f.task && n.task ? { task: n.task } : {}),
        ...(!f.agent && n.agent ? { agent: n.agent } : {}),
        ...(!f.model && n.model ? { model: n.model } : {}),
        ...(f.durationMs === undefined && n.durationMs !== undefined ? { durationMs: n.durationMs } : {}),
        ...(!f.tokens && n.tokens ? { tokens: n.tokens } : {}),
      };
      return n.status === "unknown" ? { ...f, ...fill } : { ...f, ...fill, status: n.status, ...(n.sortTime !== undefined ? { sortTime: n.sortTime } : {}) };
    });
    return asyncRows.filter((t) => !aggregateParents.has(t.parentId)).concat(mergedNotices, mergedForeground);
  };

  /** Candidate IDs must identify one selected execution, not an array position or projection node. */
  const costIds = (rows: Tracked[]): Map<string, string> => {
    const candidates = new Map<string, string>();
    for (const row of rows) {
      const siblings = rows.filter((r) => r.parentId && r.parentId === row.parentId).length;
      let id = row.childId;
      if (!id && row.parentId && siblings === 1) {
        if ((row.key.startsWith("foreground:") && row.singleParent) ||
            (row.key.startsWith("async:") && row.path.length === 1) ||
            (row.key.startsWith("notice:") && !row.workflowKey)) id = row.parentId;
      }
      if (id && id !== "unavailable") candidates.set(row.key, id);
    }
    const counts = new Map<string, number>();
    for (const id of candidates.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [key, id] of candidates) if (counts.get(id) !== 1) candidates.delete(key);
    return candidates;
  };
  const needsCost = (): boolean => {
    const rows = selected();
    const ids = costIds(rows);
    return rows.some((r) => FINAL.has(r.status) && !r.tokens && ids.has(r.key) &&
      costUsage.get(r.key)?.id !== ids.get(r.key));
  };
  const applyCost = (data: unknown): void => {
    if (!isRec(data) || data.version !== 1 || !Array.isArray(data.children) || data.children.length > 1000) return;
    const byId = new Map<string, { count: number; tokens?: string }>();
    for (const item of data.children) {
      if (!isRec(item)) continue;
      const id = safeId(item.runId);
      if (!id || id === "unavailable") continue;
      const prior = byId.get(id);
      if (prior) { prior.count++; continue; }
      const usage = isRec(item.usage) ? item.usage : {};
      const input = nonNegInt(usage.input), output = nonNegInt(usage.output);
      const sum = input !== undefined && output !== undefined ? nonNegInt(input + output) : undefined;
      const tokens = sum !== undefined ? `${sum} tok` : input !== undefined && output === undefined ? `${input} in` : output !== undefined && input === undefined ? `${output} out` : undefined;
      byId.set(id, { count: 1, ...(tokens !== undefined ? { tokens } : {}) });
    }
    const rows = selected();
    const ids = costIds(rows);
    let updated = false;
    for (const row of rows) {
      const id = ids.get(row.key);
      const cost = id ? byId.get(id) : undefined;
      if (!id || !FINAL.has(row.status) || row.tokens || cost?.count !== 1 || cost.tokens === undefined) {
        if (costUsage.delete(row.key)) updated = true;
        continue;
      }
      const prev = costUsage.get(row.key);
      if (prev?.id !== id || prev.tokens !== cost.tokens) { costUsage.set(row.key, { id, tokens: cost.tokens }); updated = true; }
    }
    if (updated) changed();
  };
  const scheduleCost = (): boolean => {
    if (!costDue || disposed || rebuilding || link !== "bound" || !info.cost || !sameSession(boundSession, currentSession())) return false;
    if (!needsCost()) { costDue = false; return false; }
    costDue = false;
    if (costToken) { costDirty = true; return true; }
    if (costTimer !== undefined) return true;
    costTimer = setTimeout(() => {
      costTimer = undefined;
      if (disposed || link !== "bound" || !info.cost || !sameSession(boundSession, currentSession()) || !needsCost()) return;
      const session = currentSession(), gen = generation, token = {};
      costToken = token;
      costDirty = false;
      const cancel = rpcRequest(events, uuid(), "cost", {}, COST_TIMEOUT_MS, (result) => {
        if (disposed || costToken !== token || generation !== gen) return;
        costToken = undefined;
        cancelCost = undefined;
        if (!sameSession(session, currentSession()) || !sameSession(boundSession, currentSession())) return;
        if (result.kind === "ok") applyCost(result.data);
        if (costDirty) { costDirty = false; costDue = true; scheduleCost(); }
      });
      if (costToken === token) cancelCost = cancel;
    }, COALESCE_MS);
    (costTimer as { unref?: () => void }).unref?.();
    return true;
  };

  const elapsed = (t: Tracked, time: number): number | undefined => {
    if (t.status !== "running" || t.stale) return t.durationMs ?? (t.startedAt !== undefined && t.endedAt !== undefined && t.endedAt >= t.startedAt ? t.endedAt - t.startedAt : undefined);
    if (t.durationMs !== undefined && t.observedAt !== undefined) return t.durationMs + Math.max(0, time - t.observedAt);
    if (t.startedAt !== undefined && time >= t.startedAt) return time - t.startedAt;
    return t.durationMs;
  };
  const clearElapsed = (): void => {
    if (elapsedTimer !== undefined) clearTimeout(elapsedTimer);
    elapsedTimer = undefined;
  };
  const scheduleElapsed = (): void => {
    if (disposed || !started || rebuilding || elapsedTimer !== undefined || !sameSession(boundSession, currentSession())) return;
    if (!selected().some((t) => t.status === "running" && !t.stale && (t.startedAt !== undefined || (t.durationMs !== undefined && t.observedAt !== undefined)))) return;
    elapsedTimer = setTimeout(() => { elapsedTimer = undefined; changed(); }, 1000);
    (elapsedTimer as { unref?: () => void }).unref?.();
  };

  const foregroundKey = (scope: string, index: number, parent: boolean): string =>
    `${parent ? "foreground" : "tool"}:${JSON.stringify([scope, index])}`;

  const observeTool = (callValue: unknown, value: unknown, final: boolean, sortTime?: number): void => {
    if (disposed || !started || !sameSession(boundSession, currentSession())) return;
    const call = safeId(callValue);
    if (!call || (!rebuilding && retiredCalls.has(call))) return;
    const wrapper = isRec(value) ? value : {};
    const details = isRec(wrapper.details) ? wrapper.details : undefined;
    const declaredCall = safeId(details?.toolCallId);
    if (declaredCall && declaredCall !== call) return;
    const parent = safeId(details?.runId);
    const existingParent = callParents.get(call);
    if (parent && existingParent && parent !== existingParent) {
      foregroundNotes = ["conflicting foreground run identity ignored"];
      changed();
      return;
    }
    if (parent && !existingParent) {
      callParents.set(call, parent);
      for (const [key, record] of foreground) {
        if (record.path[0] !== call || record.parentId) continue;
        const promoted = foregroundKey(parent, Number(record.path[1]), true);
        foreground.delete(key);
        const prior = foreground.get(promoted);
        if (!prior || (record.authority ?? 0) > (prior.authority ?? 0)) foreground.set(promoted, { ...record, key: promoted, parentId: parent });
      }
    }
    const scope = parent ?? existingParent;
    const rows = Array.isArray(details?.results) ? details.results.slice(0, MAX_CHILDREN) : [];
    const indexes = new Map<number, number>();
    for (const row of rows) if (isRec(row)) {
      const i = nonNegInt(row.index);
      if (i !== undefined) indexes.set(i, (indexes.get(i) ?? 0) + 1);
    }
    const progress = Array.isArray(details?.progress) ? details.progress.slice(0, MAX_CHILDREN) : [];
    let malformed = false;
    for (const row of rows) {
      if (!isRec(row)) { malformed = true; continue; }
      const index = nonNegInt(row.index);
      if (index === undefined || indexes.get(index) !== 1) { malformed = true; continue; }
      const key = foregroundKey(scope ?? call, index, !!scope);
      const prev = foreground.get(key);
      const matchingProgress = progress.filter((p) => isRec(p) && nonNegInt(p.index) === index);
      const p = isRec(row.progress) ? row.progress : matchingProgress.length === 1 && isRec(matchingProgress[0]) ? matchingProgress[0] : undefined;
      const summary = isRec(row.progressSummary) ? row.progressSummary : undefined;
      let status: Status;
      if (row.timedOut === true) status = "failed";
      else if (row.cancelled === true) status = "cancelled";
      else if (row.interrupted === true) status = "interrupted";
      else if (row.stopped === true) status = "stopped";
      else if (row.detached === true) status = "detached";
      else if (final && typeof (summary?.status ?? p?.status) === "string" && ["failed", "stopped", "detached", "paused", "partial", "cancelled", "interrupted"].includes((summary?.status ?? p?.status) as string)) status = STATE_MAP[(summary?.status ?? p?.status) as string] ?? "unknown";
      else if (!final) status = typeof p?.status === "string" ? STATE_MAP[p.status] ?? "unknown" : typeof summary?.status === "string" ? STATE_MAP[summary.status] ?? "unknown" : "running";
      else if (typeof row.exitCode === "number" && Number.isSafeInteger(row.exitCode)) status = row.exitCode === 0 ? "completed" : "failed";
      else status = "unknown";
      const authority = final ? 2 : 1;
      if (prev && (prev.authority ?? 0) > authority) continue;
      if (prev && (prev.authority ?? 0) === 2 && final && prev.status !== status && prev.status !== "detached") { foregroundNotes = ["conflicting foreground terminal reports ignored"]; continue; }
      const duration = nonNegInt(summary?.durationMs) ?? nonNegInt(p?.durationMs);
      const usage = isRec(row.usage) ? row.usage : undefined;
      const input = nonNegInt(usage?.input) ?? nonNegInt(p?.inputTokens);
      const output = nonNegInt(usage?.output) ?? nonNegInt(p?.outputTokens);
      const total = nonNegInt(usage?.totalTokens) ?? (nonNegInt(usage?.input) !== undefined && nonNegInt(usage?.output) !== undefined ? nonNegInt(usage?.input)! + nonNegInt(usage?.output)! : undefined) ?? nonNegInt(p?.tokens) ?? nonNegInt(summary?.tokens);
      const tokens = total !== undefined ? `${total} tok` : input !== undefined && output !== undefined ? `${input + output} tok` : input !== undefined ? `${input} in` : output !== undefined ? `${output} out` : undefined;
      const task = rawText(row.task) ?? rawText(p?.task);
      const agent = rawText(row.agent) ?? rawText(p?.agent) ?? rawText(summary?.agent);
      const model = rawText(row.model) ?? rawText(p?.model) ?? rawText(summary?.model);
      const childId = safeId(row.runId);
      const workflowKey = safeId(row.workflowKey);
      foreground.set(key, {
        ...prev, key, path: [call, String(index)], status, stale: false, authority,
        ...(scope ? { parentId: scope } : {}),
        ...(typeof details?.mode === "string" ? { singleParent: details.mode === "single" && rows.length === 1 && indexes.get(index) === 1 } : {}),
        ...(task ? { task } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(duration !== undefined ? { durationMs: duration, ...(status === "running" && !final ? { observedAt: now() } : {}) } : {}),
        ...(childId && childId !== "unavailable" ? { childId } : {}),
        ...(workflowKey && workflowKey !== "unavailable" ? { workflowKey } : {}),
        ...(sortTime !== undefined ? { sortTime } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
      });
    }
    if (final) for (const record of foreground.values()) {
      if (record.path[0] === call && CATEGORY[record.status] === "active" && !rows.some((r) => isRec(r) && nonNegInt(r.index) === Number(record.path[1]))) {
        record.status = "unknown"; record.authority = 2;
        foregroundNotes = ["tool ended without child result"];
      }
    }
    if (malformed || (Array.isArray(details?.results) && details.results.length > MAX_CHILDREN)) foregroundNotes = ["foreground results partially unavailable"];
    if (scope && [...foreground.values()].some((t) => t.parentId === scope)) {
      const mine = [...tracked.values()].filter((t) => t.parentId === scope);
      const fgMine = [...foreground.values()].filter((t) => t.parentId === scope);
      // A single async root and a single foreground child under the same exact run id are one execution.
      const root = mine.length === 1 && mine[0]!.path.length === 1 && fgMine.length === 1 ? mine[0] : undefined;
      if (root) {
        const f = fgMine[0]!;
        if (!f.task && root.task) f.task = root.task;
        if (!f.model && root.model) f.model = root.model;
        if (!f.agent && root.agent) f.agent = root.agent;
        if (f.durationMs === undefined && root.durationMs !== undefined) f.durationMs = root.durationMs;
      }
      let dropped = false;
      for (const [key, t] of tracked) if (t.parentId === scope) { tracked.delete(key); dropped = true; }
      if (dropped && !root) foregroundNotes = ["Partial data"];
    }
    prune();
    changed();
    if (final && !rebuilding) { costDue = true; scheduleCost(); }
  };

  const observeNotice = (details: unknown, sortTime?: number): void => {
    if (disposed || !started || !sameSession(boundSession, currentSession()) || !isRec(details) || !Array.isArray(details.runs)) return;
    let partial = details.runs.length > MAX_RUNS;
    for (const run of details.runs.slice(0, MAX_RUNS)) {
      if (!isRec(run)) { partial = true; continue; }
      const parent = safeId(run.runId);
      if (!parent || parent === "unavailable") { partial = true; continue; }
      const children = Array.isArray(run.childRuns) ? run.childRuns.slice(0, MAX_CHILDREN) : [];
      if (Array.isArray(run.childRuns) && run.childRuns.length > MAX_CHILDREN) partial = true;
      const valid = children.flatMap((child) => {
        if (!isRec(child)) { partial = true; return []; }
        const id = safeId(child.runId);
        const workflowKey = safeId(child.workflowKey);
        const childId = id === "unavailable" ? undefined : id;
        const wk = workflowKey === "unavailable" ? undefined : workflowKey;
        if (!childId && !wk) { partial = true; return []; }
        return [{ child, childId, workflowKey: wk }];
      });
      const duplicate = (v: typeof valid[number]): boolean => valid.filter((other) =>
        (!!v.childId && other.childId === v.childId) || (!!v.workflowKey && other.workflowKey === v.workflowKey)).length !== 1;
      if (valid.some(duplicate)) partial = true;
      const usable = valid.filter((v) => !duplicate(v));
      if (children.length && !usable.length) partial = true;
      const entries = usable.length ? usable : children.length ? [] : [{ child: run, childId: undefined, workflowKey: undefined }];
      const single = entries.length === 1 && children.length <= 1;
      /** Exact-identity donor among async projections about to be superseded (never task/role/time). */
      const donorFor = (runId: string, childId: string | undefined, only: boolean): Tracked | undefined => {
        const mine = [...tracked.values()].filter((t) => t.parentId === runId);
        const exact = childId ? mine.filter((t) => t.path[t.path.length - 1] === `subagent:${childId}` || t.path[t.path.length - 1] === `step:${childId}`) : [];
        if (exact.length === 1) return exact[0];
        return only && mine.length === 1 && mine[0]!.path.length === 1 ? mine[0] : undefined;
      };
      for (const item of entries) {
        const aliases = [...notices.values()].filter((n) => n.parentId === parent &&
          ((!!item.childId && n.childId === item.childId) || (!!item.workflowKey && n.workflowKey === item.workflowKey)) &&
          !(item.childId && n.childId && item.childId !== n.childId) &&
          !(item.workflowKey && n.workflowKey && item.workflowKey !== n.workflowKey));
        if (aliases.length > 1) { partial = true; continue; }
        const key = aliases[0]?.key ?? `notice:${JSON.stringify([parent, item.childId ? "id" : item.workflowKey ? "workflow" : "run", item.childId ?? item.workflowKey ?? ""] )}`;
        const prev = notices.get(key);
        if (prev && ((item.childId && prev.childId && item.childId !== prev.childId) || (item.workflowKey && prev.workflowKey && item.workflowKey !== prev.workflowKey))) { partial = true; continue; }
        const status = typeof item.child.status === "string" ? STATE_MAP[item.child.status] ?? "unknown" : "unknown";
        if (prev && FINAL.has(prev.status) && prev.status !== status) continue;
        const agent = rawText(item.child.agent) ?? (single ? rawText(run.agent) : undefined);
        // Run-level taskInfo/durationMs describe the run; safe only when the run is one execution.
        const duration = single ? nonNegInt(run.durationMs) : undefined;
        const task = single ? rawText(run.taskInfo) : undefined;
        const donor = donorFor(parent, item.childId, single);
        notices.set(key, { ...prev, key, path: [parent], parentId: parent, status, stale: false,
          ...(item.childId ? { childId: item.childId } : {}),
          ...(item.workflowKey ? { workflowKey: item.workflowKey } : {}),
          ...(donor?.task && !prev?.task ? { task: donor.task } : {}),
          ...(donor?.model && !prev?.model ? { model: donor.model } : {}),
          ...(donor?.agent && !prev?.agent ? { agent: donor.agent } : {}),
          ...(donor?.durationMs !== undefined && prev?.durationMs === undefined ? { durationMs: donor.durationMs } : {}),
          ...(task ? { task } : {}),
          ...(agent ? { agent } : {}),
          ...(typeof run.source === "string" ? { noticeSource: run.source } : {}),
          ...(duration !== undefined ? { durationMs: duration } : {}),
          ...(sortTime !== undefined ? { sortTime } : {}),
        });
      }
      if (usable.length) for (const [key, t] of tracked) if (t.parentId === parent) tracked.delete(key);
      if (!usable.length && !children.length && [...foreground.values()].some((t) => t.parentId === parent)) {
        partial = true;
      }
    }
    if (partial) foregroundNotes = ["Partial data"];
    prune();
    changed();
    if (!rebuilding) { costDue = true; scheduleCost(); }
  };

  const timestamp = (value: unknown): number | undefined => {
    if (typeof value === "number") return nonNegInt(value);
    if (typeof value !== "string" || value.length > 40) return undefined;
    const parsed = Date.parse(value);
    return nonNegInt(parsed);
  };
  const observeMessage = (message: unknown, entryTime?: number): void => {
    if (!isRec(message)) return;
    const time = entryTime ?? timestamp(message.timestamp);
    if (message.role === "toolResult" && message.toolName === "subagent") observeTool(message.toolCallId, message, true, time);
    else if (message.role === "custom" && message.customType === "subagent-notify") observeNotice(message.details, time);
  };

  const rebuildBranch = (): void => {
    rebuilding = true;
    try {
      for (const entry of options.getBranch?.() ?? []) {
        if (!isRec(entry)) continue;
        const time = timestamp(entry.timestamp);
        if (entry.type === "message") observeMessage(entry.message, time);
        else if (entry.type === "custom_message" && entry.customType === "subagent-notify") observeNotice(entry.details, time);
      }
    } catch { foregroundNotes = ["current branch history unavailable"]; }
    finally { rebuilding = false; }
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

  const loadStatus = (costAfterStatus = false): void => {
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
      if (result.kind === "timeout") fail("status timed out; showing last known state");
      else if (result.kind === "error") fail(`status failed (${result.code}); showing last known state`);
      else applyStatus(result.data);
      if (gen !== generation || disposed) return;
      if (costAfterStatus) scheduleCost();
      if (dirty) { dirty = false; scheduleStatus(); }
    });
    if (statusToken === token) cancelStatus = cancel;
  };

  /** Keep last safe records; mark the provider problem. No automatic retry. */
  const fail = (reason: string): void => {
    problem = reason;
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
    const foregroundParents = new Set([...foreground.values()].map((t) => t.parentId).filter((id): id is string => !!id));
    const noticeParents = new Set([...notices.values()].filter((t) => t.childId || t.workflowKey).map((t) => t.parentId));
    for (const [key, next] of incoming) {
      if (next.parentId && (foregroundParents.has(next.parentId) || noticeParents.has(next.parentId))) {
        // Same exact run id, single foreground/notice execution: keep what the projection proves.
        const fg = [...foreground.values()].filter((t) => t.parentId === next.parentId);
        const nt = [...notices.values()].filter((t) => t.parentId === next.parentId);
        const only = next.path.length === 1 && [...incoming.values()].filter((t) => t.parentId === next.parentId).length === 1;
        const target = only && fg.length + nt.length === 1 ? (fg[0] ?? nt[0]) : undefined;
        if (target && (target.childId === undefined || target.childId === next.parentId || fg.length === 1)) {
          if (!target.task && next.task) target.task = next.task;
          if (!target.model && next.model) target.model = next.model;
          if (!target.agent && next.agent) target.agent = next.agent;
        }
        continue;
      }
      const prev = tracked.get(key);
      if (prev && FINAL.has(prev.status)) {
        if (next.status !== prev.status && FINAL.has(next.status)) conflicting += 1;
        continue; // terminal never regresses and is not reinterpreted
      }
      tracked.set(key, next);
    }
    for (const [key, prev] of tracked) {
      if (prev.path.length === 1 && prev.parentId && [...incoming.values()].some((next) => next.parentId === prev.parentId && next.path.length > 1)) {
        tracked.delete(key); // normal supersession by finer exact-identity nodes
        continue;
      }
      if (!incoming.has(key) && CATEGORY[prev.status] === "active" && !prev.stale) {
        const frozen = elapsed(prev, now());
        if (frozen !== undefined) prev.durationMs = frozen;
        prev.stale = true;
      }
    }
    if (conflicting) outNotes.push(`${conflicting} conflicting terminal reports ignored`);
    prune();
  };

  const prune = (): void => {
    const effective = new Map(selected().map((t) => [t.key, t]));
    const inactive = [...tracked.values(), ...foreground.values(), ...notices.values()].map((t) => effective.get(t.key) ?? t).filter((t) => CATEGORY[t.status] !== "active").sort(byRecency);
    if (inactive.length > MAX_NON_ACTIVE) {
      for (const t of inactive.slice(MAX_NON_ACTIVE)) { tracked.delete(t.key); foreground.delete(t.key); notices.delete(t.key); }
      historyLimited = true;
    }
    const keys = new Set([...tracked.keys(), ...foreground.keys(), ...notices.keys()]);
    for (const key of costUsage.keys()) if (!keys.has(key)) costUsage.delete(key);
    const retainedCalls = new Set([...foreground.values()].map((t) => t.path[0]));
    for (const call of callParents.keys()) if (!retainedCalls.has(call)) callParents.delete(call);
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
    loadStatus(true);
  };

  // -- public --------------------------------------------------------------

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      boundSession = currentSession();
      rebuildBranch();
      costDue = true;
      scheduleElapsed();
      // Known names first, so nothing is missed between ping and status.
      subs.set(RPC_READY_EVENT, listen(RPC_READY_EVENT, true));
      subs.set(JOBS_CHANGED_EVENT, listen(JOBS_CHANGED_EVENT, false));
      connect();
    },

    snapshot(): MonitorSnapshot {
      if (started && !sameSession(boundSession, currentSession())) {
        return { state: "unavailable", records: [], diagnostics: ["session changed; awaiting session start"] };
      }
      if (!loaded && foreground.size === 0 && notices.size === 0) {
        return {
          state: link === "down" ? "unavailable" : started ? "connecting" : "pending",
          records: [],
          ...(problem ? { diagnostics: [problem] } : {}),
        };
      }
      const list = selected().sort(byRecency);
      const ids = costIds(list);
      let stale = 0;
      const records: SnapshotRecord[] = list.map((t) => {
        if (t.stale) stale += 1;
        const duration = formatDuration(undefined, undefined, elapsed(t, now()));
        const usage = costUsage.get(t.key);
        const tokens = t.tokens ?? (FINAL.has(t.status) && usage?.id === ids.get(t.key) ? usage?.tokens : undefined);
        return {
          key: t.key,
          category: CATEGORY[t.status],
          statusLabel: t.stale ? `${t.status} (stale)` : t.status,
          ...(t.task ? { task: t.task } : {}),
          ...(t.agent ? { agent: t.agent } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(duration ? { duration } : {}),
          ...(tokens ? { tokens } : {}),
        };
      });
      const diagnostics = [
        ...(problem ? [problem] : []),
        ...(stale ? [`${stale} active not in latest projection`] : []),
        ...notes,
        ...foregroundNotes,
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
      cancelInflight();
      clearElapsed();
      retiredCalls = new Set([...callParents.keys(), ...[...foreground.values()].map((t) => t.path[0]!).filter(Boolean)]);
      tracked.clear(); foreground.clear(); notices.clear(); callParents.clear(); costUsage.clear(); fleet = undefined; notes = []; foregroundNotes = []; historyLimited = false; loaded = false; problem = undefined;
      boundSession = currentSession();
      rebuildBranch();
      costDue = true;
      changed();
      connect();
    },

    observeTool,
    observeMessage,
    agentSettled(): void { costDue = true; scheduleCost(); },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelInflight();
      clearElapsed();
      for (const unsub of subs.values()) unsub();
      subs.clear();
      tracked = new Map();
      foreground.clear(); notices.clear(); callParents.clear(); retiredCalls.clear(); costUsage.clear();
    },
  };
}
