/**
 * Atelier sidebar publisher and pure row renderer.
 *
 * Talks to Atelier only through the public `pi-atelier:sidebar-panels` v1
 * event protocol. It presents snapshots and never mutates executions.
 */

export const SIDEBAR_CHANNEL = "pi-atelier:sidebar-panels";
export const PANEL_SOURCE = "subagents-bar";
export const PANEL_ID = "subagents-bar:subagents";
export const PANEL_TITLE = "Subagents";
import { PENDING_SNAPSHOT } from "./types.ts";
import type { EventTransport, MonitorSnapshot, RecordCategory, SnapshotRecord } from "./types.ts";

export { PENDING_SNAPSHOT };
export type { EventTransport, MonitorSnapshot, RecordCategory, SnapshotRecord };

export const MAX_ROWS = 24;
export const MAX_ROW_CHARS = 160;
export const MAX_TITLE_CHARS = 48;
const MAX_REQUEST_ID_UNITS = 256;

export type SidebarRole =
  | "primary" | "accent" | "muted" | "dim" | "ready" | "working"
  | "success" | "caution" | "warning" | "error";

export interface SidebarRow {
  text: string;
  role?: SidebarRole;
}

export interface SidebarPanel {
  id: string;
  title: string;
  rows: SidebarRow[];
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const OTHER_ESC = /\u001b[@-Z\\-_]?/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Bound raw input, strip escapes/controls/newlines, cap by code points. */
export function sanitizeText(value: unknown, maxChars = MAX_ROW_CHARS): string {
  if (typeof value !== "string") return "";
  const clean = value
    .slice(0, maxChars * 8)
    .replace(OSC, " ")
    .replace(CSI, " ")
    .replace(OTHER_ESC, " ")
    .replace(CONTROLS, " ")
    .replace(LONE_SURROGATE, "\uFFFD")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(clean);
  if (points.length <= maxChars) return clean;
  return points.slice(0, Math.max(0, maxChars - 3)).join("").trimEnd() + "...";
}

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

const ORDER: RecordCategory[] = ["active", "failed", "neutral", "success"];
// BMP symbols only. Atelier's nerdFont/plain-text setting is not part of the public
// sidebar-panels protocol, so private config is never read; these glyphs render in plain mode.
const MARKER: Record<RecordCategory, string> = { active: "[●]", failed: "[✕]", neutral: "[~]", success: "[✓]" };
const ROLE: Record<RecordCategory, SidebarRole> = {
  active: "working", failed: "error", neutral: "caution", success: "success",
};
const WORD: Record<RecordCategory, string> = {
  active: "active", failed: "failed", neutral: "other", success: "done",
};
const SEP = " · ";

const row = (text: string, role?: SidebarRole): SidebarRow => ({
  text: sanitizeText(text),
  ...(role ? { role } : {}),
});

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type Counts = Record<RecordCategory, number>;
const emptyCounts = (): Counts => ({ active: 0, failed: 0, neutral: 0, success: 0 });
const describe = (c: Counts): string =>
  ORDER.filter((k) => c[k] > 0).map((k) => `${c[k]} ${WORD[k]}`).join(", ");

function summaryRow(snapshot: MonitorSnapshot, counts: Counts): SidebarRow {
  if (snapshot.state === "pending") return row("Monitor integration pending", "caution");
  const known = counts.active + counts.failed + counts.neutral + counts.success;
  if (!known && snapshot.state === "connecting") return row("Connecting to subagent provider", "caution");
  if (!known && snapshot.state === "unavailable") return row("Subagent provider unavailable", "caution");
  if (!known) return row("No known subagents", "muted");
  const text = `● ${counts.active} run · ✓ ${counts.success} done · ✕ ${counts.failed} err` +
    (counts.neutral > 0 ? ` · ~ ${counts.neutral} other` : "");
  return row(text, counts.active > 0 ? "working" : counts.failed > 0 ? "error" : "primary");
}

function diagnosticRow(snapshot: MonitorSnapshot): SidebarRow | undefined {
  if (snapshot.state === "pending") return row("No subagent data read yet", "muted");
  const parts: string[] = [];
  const active = count(snapshot.fleet?.active);
  const outside = count(snapshot.fleet?.outside);
  // A bare zero fleet count carries no information for the user.
  if (active !== undefined && (active > 0 || outside)) {
    parts.push(`Provider: ${active} active${outside ? `; ${outside} outside fleet window` : ""}`);
  }
  for (const d of snapshot.diagnostics ?? []) parts.push(d);
  if (snapshot.historyLimited) parts.push("history limited");
  return parts.length ? row(parts.join("; "), "caution") : undefined;
}

/** Strip provider prefix and a known thinking-level suffix; never invent names. */
export function shortModel(value: unknown): string {
  const text = sanitizeText(value, 80);
  const name = text.slice(text.lastIndexOf("/") + 1).replace(/:(off|minimal|low|medium|high|xhigh)$/i, "");
  return sanitizeText(name || text, 40);
}

const groupDigits = (text: string): string =>
  text.replace(/^\d+/, (n) => n.replace(/\B(?=(\d{3})+$)/g, ","));

function recordRows(rec: SnapshotRecord, twoRows: boolean): SidebarRow[] {
  const role = ROLE[rec.category];
  const agent = sanitizeText(rec.agent, 40);
  const task = sanitizeText(rec.task, 100);
  const model = shortModel(rec.model);
  const title = task || agent || "Subagent";
  const label = sanitizeText(rec.statusLabel, 24);
  const status = /stale/i.test(label) ? "stale" : ["", "running", "completed", "failed"].includes(label) ? "" : label;
  const duration = sanitizeText(rec.duration, 24);
  const tokens = groupDigits(sanitizeText(rec.tokens, 40));
  const head = `${MARKER[rec.category]} ${title}${task && agent ? ` (${agent})` : ""}${model ? `${SEP}${model}` : ""}`;
  const metrics = [status, duration && `⏱ ${duration}`, tokens].filter(Boolean);
  if (!metrics.length) return [row(head, role)];
  if (!twoRows) return [row([head, ...metrics].join(SEP), role)];
  return [row(head, role), { ...row(`↳ ${metrics.join(SEP)}`, "muted"), text: `  ${sanitizeText(`↳ ${metrics.join(SEP)}`, MAX_ROW_CHARS - 2)}` }];
}

/** Build the bounded panel for a snapshot. `expanded=false` is summary-only. */
export function renderPanel(snapshot: MonitorSnapshot, expanded: boolean): SidebarPanel {
  const records = ORDER.flatMap((c) => snapshot.records.filter((r) => r.category === c));
  const counts = emptyCounts();
  for (const r of records) counts[r.category] += 1;

  const rows: SidebarRow[] = [summaryRow(snapshot, counts)];
  const diag = diagnosticRow(snapshot);
  if (diag) rows.push(diag);

  if (expanded && records.length > 0) {
    const avail = MAX_ROWS - rows.length;
    // Records that fit at `per` rows each, reserving one overflow row when needed.
    const capacity = (per: number): number =>
      records.length * per <= avail ? records.length : Math.max(0, Math.floor((avail - 1) / per));
    const activeShown = (per: number): number => Math.min(counts.active, capacity(per));
    // Collapse to one row per execution only if it materially preserves active visibility.
    const per = activeShown(1) > activeShown(2) ? 1 : 2;
    const cap = capacity(per);
    for (const rec of records.slice(0, cap)) rows.push(...recordRows(rec, per === 2));
    const hidden = records.slice(cap);
    if (hidden.length > 0) {
      const hc = emptyCounts();
      for (const r of hidden) hc[r.category] += 1;
      rows.push(row(`+${hidden.length} more known: ${describe(hc)}`, "muted"));
    }
  }
  return { id: PANEL_ID, title: sanitizeText(PANEL_TITLE, MAX_TITLE_CHARS), rows: rows.slice(0, MAX_ROWS) };
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

const ALLOCATOR_KEY = Symbol.for("pi-subagents-bar.sidebar-revisions");

/** Process-local revision counter per bus, surviving publisher replacement. */
function nextRevision(events: object): number {
  const slot = globalThis as unknown as Record<symbol, WeakMap<object, number> | undefined>;
  const map = (slot[ALLOCATOR_KEY] ??= new WeakMap<object, number>());
  const next = (map.get(events) ?? 0) + 1;
  map.set(events, next);
  return next;
}

function isRequestId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_UNITS) return false;
  if (value.trim() === "" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  return !new RegExp(LONE_SURROGATE.source).test(value);
}

export interface SidebarPublisher {
  update(panel: SidebarPanel): void;
  dispose(): void;
}

/** Subscribes to discovery first, then registers; unregisters once on dispose. */
export function createSidebarPublisher(events: EventTransport, initial: SidebarPanel): SidebarPublisher {
  let disposed = false;
  let current = initial;
  let published = JSON.stringify(initial);

  const emitRegister = (requestId?: string): void => {
    if (disposed) return;
    events.emit(SIDEBAR_CHANNEL, {
      version: 1,
      type: "register",
      source: PANEL_SOURCE,
      revision: nextRevision(events),
      panel: current,
      ...(requestId ? { requestId } : {}),
    });
  };

  const unsubscribe = events.on(SIDEBAR_CHANNEL, (data) => {
    if (disposed || typeof data !== "object" || data === null) return;
    const e = data as Record<string, unknown>;
    if (e.version !== 1 || e.type !== "discover" || !isRequestId(e.requestId)) return;
    emitRegister(e.requestId);
  });

  emitRegister();

  return {
    update(panel) {
      if (disposed) return;
      const serialized = JSON.stringify(panel);
      if (serialized === published) return;
      current = panel;
      published = serialized;
      emitRegister();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      events.emit(SIDEBAR_CHANNEL, {
        version: 1,
        type: "unregister",
        source: PANEL_SOURCE,
        revision: nextRevision(events),
        id: PANEL_ID,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Controller: snapshot source + expanded/summary-only mode + publisher
// ---------------------------------------------------------------------------

export interface AtelierPanelController {
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;
  /** Re-render from the snapshot source; later monitors call this on change. */
  refresh(): void;
  dispose(): void;
}

export function createAtelierPanel(
  events: EventTransport,
  options: { expanded?: boolean; snapshot?: () => MonitorSnapshot } = {},
): AtelierPanelController {
  let expanded = options.expanded ?? true;
  const snapshot = options.snapshot ?? (() => PENDING_SNAPSHOT);
  const render = () => renderPanel(snapshot(), expanded);
  const publisher = createSidebarPublisher(events, render());
  return {
    isExpanded: () => expanded,
    setExpanded(value) {
      expanded = value;
      publisher.update(render());
    },
    refresh: () => publisher.update(render()),
    dispose: () => publisher.dispose(),
  };
}
