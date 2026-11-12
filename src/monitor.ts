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
 * Structured notices, cost enrichment and elapsed refresh remain pending.
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
  getBranch?: () => readonly unknown[];
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
  observeTool(toolCallId: unknown, result: unknown, final: boolean): void;
  observeMessage(message: unknown): void;
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
  parentId?: string;
  durationMs?: number;
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

  let disposed = false;
  let started = false;
  let generation = 0;
  let link: Link = "idle";
  let problem: string | undefined;
  let loaded = false;
  let info: ProviderInfo = { fleet: false, snapshot: false, events: [] };

  let tracked = new Map<string, Tracked>();
  let foreground = new Map<string, Tracked>();
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

  const foregroundKey = (scope: string, index: number, parent: boolean): string =>
    `${parent ? "foreground" : "tool"}:${JSON.stringify([scope, index])}`;

  const observeTool = (callValue: unknown, value: unknown, final: boolean): void => {
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
      if (prev && (prev.authority ?? 0) === 2 && final && prev.status !== status) { foregroundNotes = ["conflicting foreground terminal reports ignored"]; continue; }
      const duration = nonNegInt(summary?.durationMs) ?? nonNegInt(p?.durationMs);
      const usage = isRec(row.usage) ? row.usage : undefined;
      const input = nonNegInt(usage?.input) ?? nonNegInt(p?.inputTokens);
      const output = nonNegInt(usage?.output) ?? nonNegInt(p?.outputTokens);
      const total = nonNegInt(usage?.totalTokens) ?? (nonNegInt(usage?.input) !== undefined && nonNegInt(usage?.output) !== undefined ? nonNegInt(usage?.input)! + nonNegInt(usage?.output)! : undefined) ?? nonNegInt(p?.tokens) ?? nonNegInt(summary?.tokens);
      const tokens = total !== undefined ? `${total} tok` : input !== undefined && output !== undefined ? `${input + output} tok` : input !== undefined ? `${input} in` : output !== undefined ? `${output} out` : undefined;
      const task = rawText(row.task) ?? rawText(p?.task);
      const agent = rawText(row.agent) ?? rawText(p?.agent) ?? rawText(summary?.agent);
      const model = rawText(row.model) ?? rawText(p?.model) ?? rawText(summary?.model);
      foreground.set(key, {
        ...prev, key, path: [call, String(index)], status, stale: false, authority,
        ...(scope ? { parentId: scope } : {}),
        ...(task ? { task } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(duration !== undefined ? { durationMs: duration } : {}),
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
      for (const [key, t] of tracked) if (t.parentId === scope) tracked.delete(key);
    }
    prune();
    changed();
  };

  const observeMessage = (message: unknown): void => {
    if (!isRec(message) || message.role !== "toolResult" || message.toolName !== "subagent") return;
    observeTool(message.toolCallId, message, true);
  };

  const rebuildBranch = (): void => {
    rebuilding = true;
    try {
      for (const entry of options.getBranch?.() ?? []) {
        if (isRec(entry) && entry.type === "message") observeMessage(entry.message);
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
    const foregroundParents = new Set([...foreground.values()].map((t) => t.parentId).filter((id): id is string => !!id));
    for (const [key, next] of incoming) {
      if (next.parentId && foregroundParents.has(next.parentId)) continue;
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
    const parents = new Set([...foreground.values()].map((t) => t.parentId).filter((id): id is string => !!id));
    const inactive = [...tracked.values()].filter((t) => !t.parentId || !parents.has(t.parentId)).concat([...foreground.values()]).filter((t) => CATEGORY[t.status] !== "active").sort(byRecency);
    if (inactive.length <= MAX_NON_ACTIVE) return;
    for (const t of inactive.slice(MAX_NON_ACTIVE)) { tracked.delete(t.key); foreground.delete(t.key); }
    const retainedCalls = new Set([...foreground.values()].map((t) => t.path[0]));
    for (const call of callParents.keys()) if (!retainedCalls.has(call)) callParents.delete(call);
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
      boundSession = currentSession();
      rebuildBranch();
      // Known names first, so nothing is missed between ping and status.
      subs.set(RPC_READY_EVENT, listen(RPC_READY_EVENT, true));
      subs.set(JOBS_CHANGED_EVENT, listen(JOBS_CHANGED_EVENT, false));
      connect();
    },

    snapshot(): MonitorSnapshot {
      if (started && !sameSession(boundSession, currentSession())) {
        return { state: "unavailable", records: [], diagnostics: ["session changed; awaiting session start"] };
      }
      if (!loaded && foreground.size === 0) {
        return {
          state: link === "down" ? "unavailable" : started ? "connecting" : "pending",
          records: [],
          ...(problem ? { diagnostics: [problem] } : {}),
        };
      }
      const parents = new Set([...foreground.values()].map((t) => t.parentId).filter((id): id is string => !!id));
      const list = [...tracked.values()].filter((t) => !t.parentId || !parents.has(t.parentId)).concat([...foreground.values()]).sort(byRecency);
      let stale = 0;
      const records: SnapshotRecord[] = list.map((t) => {
        if (t.stale) stale += 1;
        const duration = formatDuration(t.startedAt, t.endedAt, t.durationMs);
        return {
          key: t.key,
          category: CATEGORY[t.status],
          statusLabel: t.stale ? `${t.status} (stale)` : t.status,
          ...(t.task ? { task: t.task } : {}),
          ...(t.agent ? { agent: t.agent } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(duration ? { duration } : {}),
          ...(t.tokens ? { tokens: t.tokens } : {}),
        };
      });
      const diagnostics = [
        ...(problem ? [problem] : []),
        ...(stale ? [`${stale} active not in latest projection`] : []),
        ...notes,
        ...foregroundNotes,
        "notices, cost and elapsed refresh pending",
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
      retiredCalls = new Set([...callParents.keys(), ...[...foreground.values()].map((t) => t.path[0]!).filter(Boolean)]);
      tracked.clear(); foreground.clear(); callParents.clear(); fleet = undefined; notes = []; foregroundNotes = []; historyLimited = false; loaded = false; problem = undefined;
      boundSession = currentSession();
      rebuildBranch();
      changed();
      connect();
    },

    observeTool,
    observeMessage,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelInflight();
      for (const unsub of subs.values()) unsub();
      subs.clear();
      tracked = new Map();
      foreground.clear(); callParents.clear(); retiredCalls.clear();
    },
  };
}
