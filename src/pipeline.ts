import type { KnowyouConfig } from "./config.js";
import { scanPhase, type ClassifiedFile, type FileStatus } from "./scan/scan.js";
import { observePhase, type ScanDeps, type ObserveReport } from "./observe/observe.js";
import { loadState, saveState, type ScanState } from "./scan/state.js";
import { formatLocalTimestamp } from "./time.js";

export interface ScanReport {
	filesSeen: number;
	unchanged: number;
	pending: number;
	noise: number;
	observations: Array<{ file: string; summary: string; chars: number }>;
	/** Candidates absorbed without an observation — model reported no new info. */
	skipped?: number;
	/** Raw slices left for the next run because of observe.maxSlicesPerRun. */
	deferred?: number;
	errors: Array<{ file: string; error: string }>;
}

/**
 * Scan → observe pipeline (consolidation runs separately in the CLI, after a state
 * save, so its pool view includes observations written by this run).
 */
export async function runScan(config: KnowyouConfig, home: string, now = new Date(), deps: ScanDeps = {}): Promise<ScanReport> {
	const state: ScanState = loadState(home);
	const scan = await scanPhase(config, state, now);
	const observe: ObserveReport = await observePhase(config, home, state, scan, now, deps);

	const counts = scan.harnesses.reduce(
		(acc, h) => {
			for (const status of Object.keys(h.counts) as FileStatus[]) acc[status] = (acc[status] ?? 0) + h.counts[status];
			return acc;
		},
		{} as Record<string, number>,
	);
	const allErrors = [...scan.errors.map((e) => ({ file: e.file, error: e.error })), ...observe.errors];
	state.lastRun = {
		at: formatLocalTimestamp(now),
		ok: allErrors.length === 0,
		errorCount: allErrors.length,
		lastError: allErrors[0]?.error,
	};
	saveState(home, state);
	return {
		filesSeen: Object.values(counts).reduce((a, b) => a + b, 0),
		unchanged: counts["unchanged"] ?? 0,
		pending: counts["pending"] ?? 0,
		noise: counts["noise"] ?? 0,
		observations: observe.observations,
		skipped: observe.skipped,
		deferred: observe.deferred,
		errors: allErrors,
	};
}

export type { ClassifiedFile };
