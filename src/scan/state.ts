import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../atomic.js";
import { join } from "node:path";

/**
 * Per-session-file watermark. `offset` is the byte position up to which the file has been
 * *absorbed into an observation* — it only advances on distill (or when a session is
 * marked noise), never on a below-threshold increment, so sub-threshold fragments
 * accumulate into the next round. `bytes`/`mtimeMs` mirror the file as last seen so an
 * unchanged file is skipped without re-reading; `pending` records that the last decision
 * was "below threshold", which is also valid only while the file is unchanged.
 */
export interface SessionWatermark {
  bytes: number;
  mtimeMs: number;
  offset: number;
  userTurns: number;
  noise: boolean;
  pending: boolean;
  chunks: number;
}

export interface ScanState {
  version: 1;
  sessions: Record<string, SessionWatermark>;
  /** Outcome of the last real pipeline run — surfaced by `knowyou status`. */
  lastRun?: { at: string; ok: boolean; errorCount: number; lastError?: string };
}

export function loadState(home: string): ScanState {
  const file = join(home, ".state.json");
  if (!existsSync(file)) return { version: 1, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ScanState>;
    if (raw.version !== 1 || typeof raw.sessions !== "object" || raw.sessions === null) {
      return { version: 1, sessions: {} };
    }
    return {
      version: 1,
      sessions: raw.sessions,
      lastRun: raw.lastRun,
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function saveState(home: string, state: ScanState): void {
  mkdirSync(home, { recursive: true });
  atomicWriteFileSync(join(home, ".state.json"), JSON.stringify(state, null, "\t") + "\n");
}

/** Has the file changed since we last saw it? */
export function fileUnchanged(entry: SessionWatermark | undefined, mtimeMs: number, bytes: number): boolean {
  return entry !== undefined && entry.mtimeMs === mtimeMs && entry.bytes === bytes;
}
