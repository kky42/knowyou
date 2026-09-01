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
	/** Distill one observation batch into raw model output. Injectable for tests. */
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

/**
 * Group nearby compacted slices. Same-session continuity is preferred; remaining slots
 * are filled by the nearest session timestamps. The result is deterministic.
 */
export function batchSlices(slices: PreparedSlice[], batchSize: number): PreparedSlice[][] {
	const remaining = [...slices].sort((a, b) => compareSlices(a.slice, b.slice));
	const batches: PreparedSlice[][] = [];
	const size = Math.max(1, Math.floor(batchSize));

	while (remaining.length > 0) {
		const seed = remaining.shift()!;
		const batch: PreparedSlice[] = [seed];
		let lastSequence = seed.sequence;

		// Preserve adjacent slices from the same session first.
		while (batch.length < size) {
			const index = remaining.findIndex((candidate) => candidate.path === seed.path && candidate.sequence === lastSequence + 1);
			if (index === -1) break;
			const next = remaining.splice(index, 1)[0]!;
			batch.push(next);
			lastSequence = next.sequence;
		}

		// Fill unused capacity with the closest available time neighbors.
		while (batch.length < size && remaining.length > 0) {
			let nearest = 0;
			for (let i = 1; i < remaining.length; i++) {
				const currentDistance = Math.abs(remaining[i]!.slice.mtimeMs - seed.slice.mtimeMs);
				const nearestDistance = Math.abs(remaining[nearest]!.slice.mtimeMs - seed.slice.mtimeMs);
				if (currentDistance < nearestDistance || (currentDistance === nearestDistance && compareSlices(remaining[i]!.slice, remaining[nearest]!.slice) < 0)) {
					nearest = i;
				}
			}
			batch.push(remaining.splice(nearest, 1)[0]!);
		}
		batches.push(batch);
	}
	return batches;
}

function sourceFrontMatter(batch: PreparedSlice[]): string {
	if (batch.length === 1) {
		const source = batch[0]!.slice;
		return `source: ${JSON.stringify(source.path)}\nrange: ${source.startOffset}-${source.endOffset}\n`;
	}
	const lines = ["sources:"];
	for (const prepared of batch) {
		const slice = prepared.slice;
		lines.push(`  - harness: ${JSON.stringify(slice.harness)}`);
		lines.push(`    path: ${JSON.stringify(slice.path)}`);
		lines.push(`    range: ${slice.startOffset}-${slice.endOffset}`);
		lines.push(`    sequence: ${slice.sequence}`);
	}
	return `${lines.join("\n")}\n`;
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

/**
 * Stage 2 — preprocess raw scan slices, batch up to N compacted slices, and process batches
 * serially. A batch only advances its source watermarks after its one model call succeeds.
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
	const batches = batchSlices(prepared, config.observe.batchSize);
	const blockedPaths = new Set<string>();

	for (const batch of batches) {
		if (batch.some((item) => blockedPaths.has(item.path))) {
			report.deferred = (report.deferred ?? 0) + batch.length;
			continue;
		}

		const prompt = buildObservationPrompt(batch, config.observe.maxObservationChars);
		let raw: string;
		try {
			raw = await distill(prompt);
		} catch (error) {
			const file = batch.map((item) => item.path).join(", ");
			report.errors.push({ file, error: error instanceof Error ? error.message : String(error) });
			for (const item of batch) blockedPaths.add(item.path);
			continue;
		}

		const { summary, body } = parseObservation(raw, config.observe.maxObservationChars);
		if (!body.trim() || !summary.trim()) {
			const file = batch.map((item) => item.path).join(", ");
			report.errors.push({ file, error: "empty or malformed observation output — slices not absorbed; will retry" });
			for (const item of batch) blockedPaths.add(item.path);
			continue;
		}

		if (body.trim() === "-") {
			for (const item of batch) absorbSlice(state, item.slice);
			report.skipped = (report.skipped ?? 0) + batch.length;
			continue;
		}

		const obsPath = uniqueObservationPath(observationsDir, timestampSlug(now));
		writeFileSync(
			obsPath,
			`---\ncreated: ${formatLocalTimestamp(now)}\n${sourceFrontMatter(batch)}---\n${summary}\n\n${body}\n`,
		);
		for (const item of batch) absorbSlice(state, item.slice);
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
