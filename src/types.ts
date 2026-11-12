/** Shared contracts between the monitor (producer) and the Atelier renderer (consumer). */

export interface EventTransport {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export type RecordCategory = "active" | "failed" | "neutral" | "success";

export interface SnapshotRecord {
  key: string;
  category: RecordCategory;
  /** Explicit status label, e.g. "running", "queued", "stopped". */
  statusLabel?: string;
  /** Task or label text (raw provider text; the renderer sanitizes). */
  task?: string;
  agent?: string;
  model?: string;
  /** Preformatted display values; absent means unknown, never zero-filled. */
  duration?: string;
  tokens?: string;
}

export interface MonitorSnapshot {
  /**
   * `pending`: monitor not started; `connecting`: no provider read yet;
   * `unavailable`: provider missing/unusable; `ready`: provider data read.
   * None of the non-ready states is ever rendered as an idle fleet.
   */
  state: "pending" | "connecting" | "unavailable" | "ready";
  records: readonly SnapshotRecord[];
  /** Provider-level aggregate counts, kept separate from known-record counts. */
  fleet?: { active?: number; outside?: number };
  /** Coverage / staleness warnings (already worded by the monitor). */
  diagnostics?: readonly string[];
  historyLimited?: boolean;
}

export const PENDING_SNAPSHOT: MonitorSnapshot = { state: "pending", records: [] };
