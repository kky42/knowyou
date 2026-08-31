import type { KnowyouConfig } from "../config.js";
import { getAdapter, type CandidateInfo } from "./adapters.js";
import type { MessageEvent } from "../observe/prompts.js";
import { fileUnchanged, type ScanState, type SessionWatermark } from "./state.js";

export type FileStatus = "candidate" | "pending" | "noise" | "unchanged" | "machine" | "invalid";

export interface ScanDeps {
	/** Distill one increment into raw model output. Injectable for tests. */
	distill?: (prompt: string) => Promise<string>;
}

export interface ClassifiedFile {
	harness: string;
	path: string;
	status: FileStatus;
	bytes: number;
	mtimeMs: number;
	/** Message-text chars in the unprocessed increment (0 for unchanged). */
	newChars: number;
	/** User turns in the increment plus turns already recorded for this session. */
	userTurns: number;
	/** Byte offset after the last complete newline of the increment (candidate/noise). */
	newOffset?: number;
	/** Redacted message events — only attached for candidates (input to distillation). */
	events?: MessageEvent[];
}

export interface HarnessScan {
	name: string;
	sessions: number;
	counts: Record<FileStatus, number>;
	files: ClassifiedFile[];
}

export interface ScanResult {
	now: Date;
	cutoffMs: number;
	harnesses: HarnessScan[];
	/** Files ready to distill — the input to the observe phase. */
	candidates: ClassifiedFile[];
	/** Changed noise files whose offset should be advanced to EOF in the observe phase. */
	noiseUpdates: ClassifiedFile[];
	errors: Array<{ harness: string; file: string; error: string }>;
}

export interface ObserveReport {
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
	/** Candidates absorbed without an observation — the model reported no new info. */
	skipped?: number;
	/** Candidates left for the next run because of maxObservationsPerRun. */
	deferred?: number;
}

const EMPTY_COUNTS: Record<FileStatus, number> = {
	candidate: 0,
	pending: 0,
	noise: 0,
	unchanged: 0,
	machine: 0,
	invalid: 0,
};

/**
 * Stage 1 — pure classification. Reads session stores and watermarks, never writes
 * anything and never calls an LLM: `knowyou scan` (dry run) and the real pipeline share
 * this phase verbatim. The time window is applied inside the adapters' enumerate, so
 * out-of-window files are never even returned.
 */
export async function scanPhase(config: KnowyouConfig, state: ScanState, now = new Date()): Promise<ScanResult> {
	const cutoffMs = now.getTime() - config.scan.windowDays * 86_400_000;
	const result: ScanResult = { now, cutoffMs, harnesses: [], candidates: [], noiseUpdates: [], errors: [] };

	for (const harnessName of config.scan.harnesses) {
		const adapter = getAdapter(harnessName);
		if (!adapter) {
			result.errors.push({ harness: harnessName, file: "", error: "no adapter" });
			continue;
		}
		const harness: HarnessScan = { name: adapter.name, sessions: 0, counts: { ...EMPTY_COUNTS }, files: [] };

		for (const info of adapter.enumerate(cutoffMs)) {
			const base = { harness: adapter.name, path: info.path, bytes: info.bytes, mtimeMs: info.mtimeMs };
			const classify = (status: FileStatus, extra: Partial<ClassifiedFile> = {}): void => {
				harness.counts[status] += 1;
				harness.sessions += 1;
				const file: ClassifiedFile = { ...base, status, newChars: 0, userTurns: 0, ...extra };
				harness.files.push(file);
				if (status === "candidate") result.candidates.push(file);
				if (status === "noise" && extra.newOffset !== undefined) result.noiseUpdates.push(file);
			};

			try {
				if (!adapter.looksLikeSession(info.path)) {
					classify("invalid");
					continue;
				}
				// Non-interactive machine sessions (codex exec, claude sdk, cron bridges — and
				// any future knowyou runner on these harnesses) are excluded from memory.
				if (adapter.isExcluded(info.path)) {
					classify("machine");
					continue;
				}

				const entry: SessionWatermark = state.sessions[info.path] ?? {
					bytes: 0,
					mtimeMs: 0,
					offset: 0,
					userTurns: 0,
					noise: false,
					pending: false,
					chunks: 0,
				};

				if (fileUnchanged(entry, info.mtimeMs, info.bytes) && entry.offset >= info.bytes) {
					// Fully absorbed and unchanged: the last classification still holds.
					// A partially-absorbed file (offset < bytes after chunked distillation)
					// falls through — its remainder is re-evaluated below. Pending files also
					// re-evaluate every round so config changes take effect without new content.
					classify(entry.noise ? "noise" : entry.pending ? "pending" : "unchanged");
					continue;
				}

				const inc = adapter.readIncrement(info.path, entry.offset, config.scan.redactSecrets);
				const userTurns = entry.userTurns + inc.userTurns;

				if (userTurns < config.scan.minUserTurns) {
					// Whole-session noise. The offset must NOT advance: the unabsorbed opening
					// turns would be lost forever once the session later qualifies.
					classify("noise", { userTurns, newChars: inc.newChars });
					continue;
				}
				if (inc.newChars < config.scan.minNewChars) {
					classify("pending", { userTurns, newChars: inc.newChars, newOffset: inc.newOffset });
					continue;
				}
				classify("candidate", { userTurns, newChars: inc.newChars, newOffset: inc.newOffset, events: inc.events });
			} catch (error) {
				result.errors.push({
					harness: adapter.name,
					file: info.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		result.harnesses.push(harness);
	}

	return result;
}

