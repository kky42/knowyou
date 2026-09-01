import type { KnowyouConfig } from "../config.js";
import { getAdapter, type CandidateInfo } from "./adapters.js";
import { eventBytes, isUserMessage, type MessageEvent } from "./events.js";
import { fileUnchanged, type ScanState, type SessionWatermark } from "./state.js";
import { estimateTokensFromBytes } from "../tokens.js";

export type FileStatus = "candidate" | "pending" | "noise" | "unchanged" | "machine" | "invalid";

export interface ScanSlice {
	harness: string;
	path: string;
	bytes: number;
	mtimeMs: number;
	sequence: number;
	startOffset: number;
	endOffset: number;
	rawTokens: number;
	userTurns: number;
	events: MessageEvent[];
}

export interface ClassifiedFile {
	harness: string;
	path: string;
	status: FileStatus;
	bytes: number;
	mtimeMs: number;
	/** Estimated tokens in the complete unprocessed increment. */
	newTokens: number;
	/** User turns in the increment plus turns already absorbed for this session. */
	userTurns: number;
	/** End of the complete-line region read from the session file. */
	newOffset?: number;
	/** Raw slices selected for observation; present only for candidate files. */
	slices?: ScanSlice[];
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
	/** Raw slices ready for preprocessing and observation. */
	candidates: ScanSlice[];
	errors: Array<{ harness: string; file: string; error: string }>;
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
 * Split normalized events into raw scan slices. A JSONL line is indivisible because
 * several content blocks can share one file offset; a single oversized line is retained
 * as an exceptional slice and is bounded by preprocessing later.
 */
export function splitScanSlices(
	events: MessageEvent[],
	startOffset: number,
	finalOffset: number,
	maxTokens: number,
	minTokens = 1,
): Array<Pick<ScanSlice, "startOffset" | "endOffset" | "rawTokens" | "userTurns" | "events" | "sequence">> {
	const groups: MessageEvent[][] = [];
	for (const event of events) {
		const previous = groups.at(-1);
		if (previous && previous[0]?.endOffset !== undefined && previous[0].endOffset === event.endOffset) previous.push(event);
		else groups.push([event]);
	}

	const slices: Array<Pick<ScanSlice, "startOffset" | "endOffset" | "rawTokens" | "userTurns" | "events" | "sequence">> = [];
	let current: MessageEvent[] = [];
	let currentBytes = 0;
	let currentStart = startOffset;
	let sequence = 0;

	const flush = (endOffset: number, useFinalOffset: boolean): void => {
		if (current.length === 0) return;
		const rawTokens = estimateTokensFromBytes(currentBytes);
		slices.push({
			sequence: sequence++,
			startOffset: currentStart,
			endOffset: useFinalOffset ? finalOffset : endOffset,
			rawTokens,
			userTurns: current.filter(isUserMessage).length,
			events: current,
		});
		current = [];
		currentBytes = 0;
		currentStart = useFinalOffset ? finalOffset : endOffset;
	};

	for (const group of groups) {
		const groupBytes = group.reduce((total, event) => total + eventBytes(event), 0);
		const currentTokens = estimateTokensFromBytes(currentBytes);
		// Do not strand a sub-minimum prefix. Keeping it with the next complete line
		// preserves the conversation and may produce a slightly-over-max slice in the
		// rare case where a single message is the only useful boundary.
		if (current.length > 0 && currentTokens >= minTokens && estimateTokensFromBytes(currentBytes + groupBytes) > maxTokens) {
			flush(current.at(-1)?.endOffset ?? currentStart, false);
		}
		// If one JSONL record is larger than the configured maximum, keep it whole. The
		// preprocessing cap handles it without making the watermark point into a line.
		current.push(...group);
		currentBytes += groupBytes;
	}
	// A short tail remains pending. Its offset is deliberately not returned, so a later
	// append is scanned together with it instead of silently absorbing a partial slice.
	if (estimateTokensFromBytes(currentBytes) >= minTokens) flush(current.at(-1)?.endOffset ?? currentStart, true);
	return slices;
}

/**
 * Stage 1 — pure classification. It reads supported session stores and watermarks,
 * selects raw token-bounded slices, and never calls an LLM or writes anything.
 */
export async function scanPhase(config: KnowyouConfig, state: ScanState, now = new Date()): Promise<ScanResult> {
	const cutoffMs = now.getTime() - config.scan.windowDays * 86_400_000;
	const result: ScanResult = { now, cutoffMs, harnesses: [], candidates: [], errors: [] };

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
				const file: ClassifiedFile = { ...base, status, newTokens: 0, userTurns: 0, ...extra };
				harness.files.push(file);
				if (status === "candidate" && file.slices) result.candidates.push(...file.slices);
			};

			try {
				const entry: SessionWatermark = state.sessions[info.path] ?? {
					bytes: 0,
					mtimeMs: 0,
					offset: 0,
					userTurns: 0,
					noise: false,
					pending: false,
					chunks: 0,
				};

				// Fully absorbed unchanged sessions need no header read or parsing.
				if (fileUnchanged(entry, info.mtimeMs, info.bytes) && entry.offset >= info.bytes) {
					classify(entry.noise ? "noise" : entry.pending ? "pending" : "unchanged");
					continue;
				}

				const interaction = adapter.classify(info.path);
				if (interaction === "invalid") {
					classify("invalid");
					continue;
				}
				if (interaction === "non-interactive") {
					classify("machine");
					continue;
				}

				const inc = adapter.readIncrement(info.path, entry.offset, config.scan.redactSecrets);
				const totalUserTurns = entry.userTurns + inc.userTurns;

				if (totalUserTurns < config.scan.minUserTurns) {
					// Keep the offset at the consumed prefix. If this later becomes interactive,
					// the opening turns must still be available to the observer.
					classify("noise", { userTurns: totalUserTurns, newTokens: inc.newTokens });
					continue;
				}

				if (inc.newTokens < config.scan.minNewTokens) {
					classify("pending", { userTurns: totalUserTurns, newTokens: inc.newTokens, newOffset: inc.newOffset });
					continue;
				}

				const rawSlices = splitScanSlices(
					inc.events,
					entry.offset,
					inc.newOffset,
					config.scan.maxNewTokens,
					config.scan.minNewTokens,
				).map((slice) => ({
					...slice,
					harness: adapter.name,
					path: info.path,
					bytes: info.bytes,
					mtimeMs: info.mtimeMs,
				}));
				const candidateSlices = rawSlices.filter((slice) => slice.rawTokens >= config.scan.minNewTokens);
				if (candidateSlices.length === 0) {
					classify("pending", { userTurns: totalUserTurns, newTokens: inc.newTokens, newOffset: inc.newOffset });
					continue;
				}
				classify("candidate", {
					userTurns: totalUserTurns,
					newTokens: inc.newTokens,
					newOffset: inc.newOffset,
					slices: candidateSlices,
				});
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
