import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowyouConfig } from "../config.js";
import { runAgentPrompt } from "../agents/runner.js";
import { buildObservationPrompt, compressEvents, parseObservation } from "./prompts.js";
import type { ClassifiedFile, ScanResult } from "../scan/scan.js";
import type { ScanState, SessionWatermark } from "../scan/state.js";

export interface ObserveReport {
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
	/** Candidates absorbed without an observation — the model reported no new info. */
	skipped?: number;
	/** Candidates left for the next run because of maxObservationsPerRun. */
	deferred?: number;
}

export interface ScanDeps {
	/** Distill one increment into raw model output. Injectable for tests. */
	distill?: (prompt: string) => Promise<string>;
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

function ensureEntry(state: ScanState, path: string): SessionWatermark {
	return (
		state.sessions[path] ?? {
			bytes: 0,
			mtimeMs: 0,
			offset: 0,
			userTurns: 0,
			noise: false,
			pending: false,
			chunks: 0,
		}
	);
}

/**
 * Observe the candidates produced by scanPhase: distill each one, write observation
 * files, advance watermarks. The watermark only advances when an increment is absorbed
 * (distilled, no-new-info skip, or noise offset advance); failures leave it untouched so
 * the same increment retries next round.
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

	// Per-run cap: distill at most maxObservationsPerRun candidates, oldest first (matches
	// the FIFO consolidation direction). The rest stay candidates — their watermarks are
	// untouched, so they are re-offered next run.
	const ordered = [...scan.candidates].sort((a, b) => a.mtimeMs - b.mtimeMs);
	const selected = ordered.slice(0, config.limits.maxObservationsPerRun);
	report.deferred = ordered.length - selected.length;

	const processCandidate = async (candidate: ClassifiedFile): Promise<void> => {
		try {
			const entry = ensureEntry(state, candidate.path);
			const compressed = compressEvents(candidate.events ?? []);
			const prompt = buildObservationPrompt(compressed, config.limits.maxObservationChars);
			const raw = await distill(prompt);
			const { summary, body } = parseObservation(raw, config.limits.maxObservationChars);
			const absorbed = {
				...entry,
				bytes: candidate.bytes,
				mtimeMs: candidate.mtimeMs,
				offset: candidate.newOffset ?? entry.offset,
				userTurns: candidate.userTurns,
				noise: false,
				pending: false,
				chunks: entry.chunks + 1,
			};
			// The prompt's no-new-info protocol: "-" body means nothing worth remembering.
			// The increment is still absorbed (watermark advances) but no file is written.
			if (body.trim() === "-" || body.trim() === "") {
				state.sessions[candidate.path] = absorbed;
				report.skipped = (report.skipped ?? 0) + 1;
				return;
			}
			const obsPath = uniqueObservationPath(observationsDir, timestampSlug(now));
			writeFileSync(
				obsPath,
				`---\ncreated: ${now.toISOString()}\nsource: ${candidate.path}\n` +
					`range: ${entry.offset}-${candidate.newOffset}\n---\n${summary}\n\n${body}\n`,
			);
			state.sessions[candidate.path] = absorbed;
			report.observations.push({ file: obsPath, summary, chars: body.length });
		} catch (error) {
			report.errors.push({
				file: candidate.path,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	// Worker pool: at most agent.maxConcurrency distillations in flight; each worker pulls
	// the next candidate when it finishes. State updates touch disjoint keys, and the
	// file-write helpers are synchronous, so no locking is needed.
	const queue = [...selected];
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < queue.length) {
			const candidate = queue[cursor++];
			if (!candidate) break;
			await processCandidate(candidate);
		}
	};
	const workerCount = Math.max(1, Math.min(config.agent.maxConcurrency, queue.length));
	await Promise.all(Array.from({ length: workerCount }, worker));

	// Noise and below-threshold files: bookkeeping only.
	for (const file of scan.harnesses.flatMap((h) => h.files)) {
		if (file.status === "noise" && file.newOffset !== undefined) {
			state.sessions[file.path] = {
				...ensureEntry(state, file.path),
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				offset: file.newOffset,
				userTurns: file.userTurns,
				noise: true,
				pending: false,
			};
		} else if (file.status === "pending" && file.newOffset !== undefined) {
			state.sessions[file.path] = {
				...ensureEntry(state, file.path),
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				offset: ensureEntry(state, file.path).offset, // fragments accumulate — offset unchanged
				userTurns: file.userTurns,
				noise: false,
				pending: true,
			};
		}
	}

	return report;
}
