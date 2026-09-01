import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowyouConfig } from "../config.js";
import { runAgentPrompt } from "../agents/runner.js";
import { formatLocalTimestamp } from "../time.js";
import { preprocessEvents } from "./preprocess.js";
import { buildObservationPrompt, parseObservation, type ObservationInput } from "./prompts.js";
import type { ScanSlice, ScanResult } from "../scan/scan.js";
import type { ScanState, SessionWatermark } from "../scan/state.js";

export interface ObserveReport {
	observations: Array<{ file: string; summary: string; chars: number }>;
	errors: Array<{ file: string; error: string }>;
	/** Number of raw slices absorbed without an observation. */
	skipped?: number;
	/** Raw slices left for the next run because of the per-run limit or a failed predecessor. */
	deferred?: number;
}

export interface ScanDeps {
	/** Distill one compacted slice into raw model output. Injectable for integration tests. */
	distill?: (prompt: string) => Promise<string>;
}

interface PreparedSlice extends ObservationInput {
	slice: ScanSlice;
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

function compareSlices(a: ScanSlice, b: ScanSlice): number {
	return a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path) || a.sequence - b.sequence;
}

function sourceFrontMatter(source: ScanSlice): string {
	return `source: ${JSON.stringify(source.path)}\nrange: ${source.startOffset}-${source.endOffset}\n`;
}

function absorbSlice(state: ScanState, slice: ScanSlice): void {
	const entry = ensureEntry(state, slice.path);
	// A stale or duplicate slice must never move a watermark backwards.
	if (entry.offset >= slice.endOffset) return;
	state.sessions[slice.path] = {
		...entry,
		bytes: slice.bytes,
		mtimeMs: slice.mtimeMs,
		offset: slice.endOffset,
		userTurns: entry.userTurns + slice.userTurns,
		noise: false,
		pending: slice.endOffset < slice.bytes,
		chunks: entry.chunks + 1,
	};
}

/** Stage 2 — compact and observe raw slices serially, advancing each watermark on success. */
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

	const ordered = [...scan.candidates].sort(compareSlices);
	const selected = ordered.slice(0, config.observe.maxSlicesPerRun);
	report.deferred = ordered.length - selected.length;
	const prepared = selected.map((slice) => {
		const compacted = preprocessEvents(slice.events);
		return {
			slice,
			harness: slice.harness,
			path: slice.path,
			sequence: slice.sequence,
			startOffset: slice.startOffset,
			endOffset: slice.endOffset,
			rawTokens: slice.rawTokens,
			compactedTokens: compacted.estimatedTokens,
			text: compacted.text,
		};
	});
	const blockedPaths = new Set<string>();

	for (const item of prepared) {
		if (blockedPaths.has(item.path)) {
			report.deferred = (report.deferred ?? 0) + 1;
			continue;
		}

		const prompt = buildObservationPrompt(item, config.observe.maxObservationChars);
		let raw: string;
		try {
			raw = await distill(prompt);
		} catch (error) {
			report.errors.push({ file: item.path, error: error instanceof Error ? error.message : String(error) });
			blockedPaths.add(item.path);
			continue;
		}

		const { summary, body } = parseObservation(raw, config.observe.maxObservationChars);
		if (!body.trim() || !summary.trim()) {
			report.errors.push({ file: item.path, error: "empty or malformed observation output — slice not absorbed; will retry" });
			blockedPaths.add(item.path);
			continue;
		}

		if (body.trim() === "-") {
			absorbSlice(state, item.slice);
			report.skipped = (report.skipped ?? 0) + 1;
			continue;
		}

		const obsPath = uniqueObservationPath(observationsDir, timestampSlug(now));
		writeFileSync(
			obsPath,
			`---\ncreated: ${formatLocalTimestamp(now)}\n${sourceFrontMatter(item.slice)}---\n${summary}\n\n${body}\n`,
		);
		absorbSlice(state, item.slice);
		report.observations.push({ file: obsPath, summary, chars: body.length });
	}

	// Files that were below the threshold remain pending. Their offsets intentionally stay
	// unchanged, so the next scan sees the accumulated raw increment again.
	for (const file of scan.harnesses.flatMap((h) => h.files)) {
		if (file.status === "noise") {
			state.sessions[file.path] = {
				...ensureEntry(state, file.path),
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				noise: true,
				pending: false,
			};
		}
		if (file.status === "pending") {
			const entry = ensureEntry(state, file.path);
			state.sessions[file.path] = {
				...entry,
				bytes: file.bytes,
				mtimeMs: file.mtimeMs,
				// Do not persist file.userTurns: the pending region is still unread/absorbed.
				pending: true,
				noise: false,
			};
		}
	}

	return report;
}
