import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowyouConfig } from "../config.js";
import { runAgentPrompt } from "../agents/runner.js";
import { buildObservationPrompt, compressEvents, parseObservation, type MessageEvent } from "../agents/observe-prompt.js";
import { enumerateSessions, looksLikeSession, readIncrement, storeRoots } from "./pi-adapter.js";
import { fileUnchanged, loadState, saveState, type ScanState, type SessionWatermark } from "./state.js";

export type FileStatus =
	| "candidate" // changed, increment above threshold — would be distilled
	| "pending" // changed (or previously marked), increment below threshold — fragments accumulate
	| "noise" // too few user turns — never distilled
	| "unchanged" // identical to last scan
	| "out-of-window" // mtime older than the scan window
	| "invalid"; // not a recognizable session file

export interface HarnessAdapter {
	name: string;
	enumerate(): Array<{ path: string; mtimeMs: number; bytes: number }>;
	looksLikeSession(path: string): boolean;
	readIncrement(path: string, offset: number, redact: boolean): {
		events: MessageEvent[];
		userTurns: number;
		newChars: number;
		newOffset: number;
	};
}

const ADAPTERS: Record<string, HarnessAdapter> = {
	pi: { name: "pi", enumerate: enumerateSessions, looksLikeSession, readIncrement },
};

export interface ClassifiedFile {
	harness: string;
	path: string;
	status: FileStatus;
	bytes: number;
	mtimeMs: number;
	/** Message-text chars in the unprocessed increment (0 for unchanged/out-of-window). */
	newChars: number;
	/** User turns in the increment, plus turns already recorded for this session. */
	userTurns: number;
	/** Byte offset after the last complete newline of the increment (candidates/noise). */
	newOffset?: number;
	/** Redacted message events — only attached for candidates (input to distillation). */
	events?: MessageEvent[];
}

export interface ScanResult {
	now: Date;
	cutoffMs: number;
	harnesses: Array<{
		name: string;
		roots: string[];
		counts: Record<FileStatus, number>;
		files: ClassifiedFile[];
	}>;
	/** Files ready to distill — the input to the observe phase. */
	candidates: ClassifiedFile[];
	/** Changed noise files whose offset should be advanced to EOF in the observe phase. */
	noiseUpdates: ClassifiedFile[];
	errors: Array<{ harness: string; file: string; error: string }>;
}

export interface ObserveReport {
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
}

export interface ScanDeps {
	/** Distill one increment into raw model output. Injectable for tests. */
	distill?: (prompt: string) => Promise<string>;
}

const EMPTY_COUNTS: Record<FileStatus, number> = {
	candidate: 0,
	pending: 0,
	noise: 0,
	unchanged: 0,
	"out-of-window": 0,
	invalid: 0,
};

/**
 * Stage 1 — pure classification. Reads session stores and watermarks, never writes
 * anything and never calls an LLM: `knowyou scan` (dry run) and the real pipeline
 * share this phase verbatim.
 */
export async function scanPhase(config: KnowyouConfig, state: ScanState, now = new Date()): Promise<ScanResult> {
	const cutoffMs = now.getTime() - config.scan.windowDays * 86_400_000;
	const result: ScanResult = {
		now,
		cutoffMs,
		harnesses: [],
		candidates: [],
		noiseUpdates: [],
		errors: [],
	};

	for (const harnessName of config.scan.harnesses) {
		const adapter = ADAPTERS[harnessName];
		if (!adapter) {
			result.errors.push({ harness: harnessName, file: "", error: "no adapter" });
			continue;
		}
		const harness = { name: adapter.name, roots: storeRoots(), counts: { ...EMPTY_COUNTS }, files: [] as ClassifiedFile[] };

		for (const info of adapter.enumerate()) {
			const base = { harness: adapter.name, path: info.path, bytes: info.bytes, mtimeMs: info.mtimeMs };
			const classify = (status: FileStatus, extra: Partial<ClassifiedFile> = {}): void => {
				harness.counts[status] += 1;
				const file: ClassifiedFile = { ...base, status, newChars: 0, userTurns: 0, ...extra };
				harness.files.push(file);
				if (status === "candidate") result.candidates.push(file);
				if (status === "noise" && extra.newOffset !== undefined) result.noiseUpdates.push(file);
			};

			try {
				if (info.mtimeMs < cutoffMs) {
					classify("out-of-window");
					continue;
				}
				if (!adapter.looksLikeSession(info.path)) {
					classify("invalid");
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

				if (fileUnchanged(entry, info.mtimeMs, info.bytes)) {
					// Same file as last scan: its last classification still holds.
					classify(entry.noise ? "noise" : entry.pending ? "pending" : "unchanged");
					continue;
				}

				const inc = adapter.readIncrement(info.path, entry.offset, config.scan.redactSecrets);
				const userTurns = entry.userTurns + inc.userTurns;

				if (userTurns < config.scan.minUserTurns) {
					// Whole-session noise; on observe its offset advances to the new EOF.
					classify("noise", { userTurns, newChars: inc.newChars, newOffset: inc.newOffset });
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

function timestampSlug(now = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
	);
}

function uniqueObservationPath(dir: string, slug: string): string {
	let candidate = join(dir, `${slug}.md`);
	let n = 2;
	while (existsSync(candidate)) candidate = join(dir, `${slug}-${n++}.md`);
	return candidate;
}

/**
 * Stage 2 — observe the candidates: distill each one, write observation files, advance
 * watermarks. The watermark only advances when an increment is absorbed (distilled, noise
 * offset advance, or pending fast-skip flag); failures leave it untouched so the same
 * increment retries next round.
 */
export async function observePhase(
	config: KnowyouConfig,
	home: string,
	state: ScanState,
	scan: ScanResult,
	now = new Date(),
	deps: ScanDeps = {},
): Promise<ObserveReport> {
	const distill =
		deps.distill ?? ((prompt: string) => runAgentPrompt({ prompt, model: config.agent.model, thinking: config.agent.thinking }));
	const report: ObserveReport = { observations: [], errors: [] };
	const observationsDir = join(home, "observations");
	mkdirSync(observationsDir, { recursive: true });

	for (const candidate of scan.candidates) {
		try {
			const entry: SessionWatermark = state.sessions[candidate.path] ?? {
				bytes: 0,
				mtimeMs: 0,
				offset: 0,
				userTurns: 0,
				noise: false,
				pending: false,
				chunks: 0,
			};
			const compressed = compressEvents(candidate.events ?? []);
			const prompt = buildObservationPrompt(compressed, config.limits.maxObservationChars);
			const raw = await distill(prompt);
			const { summary, body } = parseObservation(raw, config.limits.maxObservationChars);
			const obsPath = uniqueObservationPath(observationsDir, timestampSlug(now));
			writeFileSync(
				obsPath,
				`---\ncreated: ${now.toISOString()}\nsource: ${candidate.path}\n` +
					`range: ${entry.offset}-${candidate.newOffset}\n---\n${summary}\n\n${body}\n`,
			);
			state.sessions[candidate.path] = {
				...entry,
				bytes: candidate.bytes,
				mtimeMs: candidate.mtimeMs,
				offset: candidate.newOffset ?? entry.offset,
				userTurns: candidate.userTurns,
				noise: false,
				pending: false,
				chunks: entry.chunks + 1,
			};
			report.observations.push({ file: obsPath, summary, chars: body.length });
		} catch (error) {
			report.errors.push({
				file: candidate.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Noise files and below-threshold files: record bookkeeping only.
	for (const file of scan.harnesses.flatMap((h) => h.files)) {
		if (file.status === "noise" && file.newOffset !== undefined) {
			const entry: SessionWatermark = state.sessions[file.path] ?? {
				bytes: 0,
				mtimeMs: 0,
				offset: 0,
				userTurns: 0,
				noise: false,
				pending: false,
				chunks: 0,
			};
			state.sessions[file.path] = {
				...entry,
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				offset: file.newOffset,
				userTurns: file.userTurns,
				noise: true,
				pending: false,
			};
		} else if (file.status === "pending" && file.newOffset !== undefined) {
			const entry: SessionWatermark = state.sessions[file.path] ?? {
				bytes: 0,
				mtimeMs: 0,
				offset: 0,
				userTurns: 0,
				noise: false,
				pending: false,
				chunks: 0,
			};
			state.sessions[file.path] = {
				...entry,
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				offset: entry.offset, // fragments accumulate — offset unchanged
				userTurns: file.userTurns,
				noise: false,
				pending: true,
			};
		}
	}

	return report;
}

export interface ScanReport {
	filesSeen: number;
	unchanged: number;
	pending: number;
	noise: number;
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
}

/** Full pipeline through the observe stage (consolidation not yet implemented). */
export async function runScan(config: KnowyouConfig, home: string, now = new Date(), deps: ScanDeps = {}): Promise<ScanReport> {
	const state = loadState(home);
	const scan = await scanPhase(config, state, now);
	const observe = await observePhase(config, home, state, scan, now, deps);
	saveState(home, state);

	const counts = scan.harnesses.reduce(
		(acc, h) => {
			for (const status of Object.keys(h.counts) as FileStatus[]) acc[status] = (acc[status] ?? 0) + h.counts[status];
			return acc;
		},
		{} as Record<string, number>,
	);
	return {
		filesSeen: Object.values(counts).reduce((a, b) => a + b, 0),
		unchanged: counts["unchanged"] ?? 0,
		pending: counts["pending"] ?? 0,
		noise: counts["noise"] ?? 0,
		observations: observe.observations,
		errors: [
			...scan.errors.map((e) => ({ file: e.file, error: e.error })),
			...observe.errors,
		],
	};
}
