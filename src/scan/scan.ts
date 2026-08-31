import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowyouConfig } from "../config.js";
import { runAgentPrompt } from "../agents/runner.js";
import { buildObservationPrompt, compressEvents, parseObservation } from "../agents/observe-prompt.js";
import { enumerateSessions, looksLikeSession, readIncrement, storeRoots } from "./pi-adapter.js";
import { fileUnchanged, loadState, saveState, type ScanState, type SessionWatermark } from "./state.js";

export interface ScanReport {
	filesSeen: number;
	unchanged: number;
	pending: number; // changed, but increment below threshold — offset kept, fragments accumulate
	noise: number;
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
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

/**
 * One scan cycle (stage A): enumerate session stores inside the time window, read each
 * file's unprocessed increment, and distill a new observation when the increment's
 * message-text chars cross the threshold. The offset watermark only advances when an
 * increment is absorbed (distilled, or the session judged noise) — below-threshold
 * fragments stay pending and roll into the next round.
 */
export async function runScan(
	config: KnowyouConfig,
	home: string,
	now = new Date(),
	deps: ScanDeps = {},
): Promise<ScanReport> {
	const distill = deps.distill ?? realDistill(config);
	const report: ScanReport = { filesSeen: 0, unchanged: 0, pending: 0, noise: 0, observations: [], errors: [] };
	const state = loadState(home);
	const cutoffMs = now.getTime() - config.scan.windowDays * 86_400_000;
	const observationsDir = join(home, "observations");
	mkdirSync(observationsDir, { recursive: true });

	for (const fileInfo of enumerateSessions()) {
		report.filesSeen += 1;
		if (fileInfo.mtimeMs < cutoffMs) continue;
		if (!looksLikeSession(fileInfo.path)) continue;

		const entry: SessionWatermark = state.sessions[fileInfo.path] ?? {
			bytes: 0,
			mtimeMs: 0,
			offset: 0,
			userTurns: 0,
			noise: false,
			pending: false,
			chunks: 0,
		};

		if (fileUnchanged(entry, fileInfo.mtimeMs, fileInfo.bytes)) {
			report.unchanged += 1;
			continue;
		}

		// Noise sessions (few user turns) are marked once and skipped until they change.
		if (entry.noise && entry.offset >= fileInfo.bytes) {
			entry.mtimeMs = fileInfo.mtimeMs;
			entry.bytes = fileInfo.bytes;
			continue;
		}

		try {
			const inc = readIncrement(fileInfo.path, entry.offset, config.scan.redactSecrets);
			const totalUserTurns = entry.userTurns + inc.userTurns;

			if (totalUserTurns < config.scan.minUserTurns) {
				// Whole-session noise judgment; safe because user turns only ever accumulate
				// in an append-only store. Advance offset to EOF — nothing to distill here.
				if (totalUserTurns > entry.userTurns || inc.newChars > 0) {
					state.sessions[fileInfo.path] = {
						...entry,
						userTurns: totalUserTurns,
						bytes: fileInfo.bytes,
						mtimeMs: fileInfo.mtimeMs,
						offset: inc.newOffset,
						noise: true,
						pending: false,
					};
					report.noise += 1;
				}
				continue;
			}

			if (inc.newChars < config.scan.minNewChars) {
				// Below threshold: keep offset so fragments accumulate; mark pending so an
				// unchanged file is skipped quickly on the next round.
				state.sessions[fileInfo.path] = {
					...entry,
					userTurns: totalUserTurns,
					bytes: fileInfo.bytes,
					mtimeMs: fileInfo.mtimeMs,
					offset: entry.offset,
					noise: false,
					pending: true,
				};
				report.pending += 1;
				continue;
			}

			// Distill: one LLM call per qualifying increment.
			const compressed = compressEvents(inc.events);
			const prompt = buildObservationPrompt(compressed, config.limits.maxObservationChars);
			const raw = await distill(prompt);
			const { summary, body } = parseObservation(raw, config.limits.maxObservationChars);
			const obsPath = uniqueObservationPath(observationsDir, timestampSlug(now));
			writeFileSync(
				obsPath,
				`---\ncreated: ${now.toISOString()}\nsource: ${fileInfo.path}\n` +
					`range: ${entry.offset}-${inc.newOffset}\n---\n${summary}\n\n${body}\n`,
			);

			state.sessions[fileInfo.path] = {
				...entry,
				userTurns: totalUserTurns,
				bytes: fileInfo.bytes,
				mtimeMs: fileInfo.mtimeMs,
				offset: inc.newOffset,
				noise: false,
				pending: false,
				chunks: entry.chunks + 1,
			};
			report.observations.push({ file: obsPath, summary, chars: body.length });
		} catch (error) {
			// Fail-soft: never advance the watermark on error — the increment retries next round.
			report.errors.push({ file: fileInfo.path, error: error instanceof Error ? error.message : String(error) });
		}
	}

	saveState(home, state);
	return report;
}

export function pendingCount(state: ScanState): number {
	return Object.values(state.sessions).filter((s) => s.pending).length;
}

function realDistill(config: KnowyouConfig) {
	return (prompt: string) => runAgentPrompt({ prompt, model: config.agent.model, thinking: config.agent.thinking });
}

export { storeRoots };
