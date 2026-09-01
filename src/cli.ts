#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { knowyouHome, loadConfig } from "./config.js";
import { loadState, saveState } from "./scan/state.js";
import { scanPhase } from "./scan/scan.js";
import { observePhase } from "./observe/observe.js";
import { renderIndex } from "./render/index-render.js";
import { runConsolidation, poolFiles } from "./consolidate/consolidate.js";
import { start as scheduleStart, stop as scheduleStop, isRegistered, plistPath } from "./schedule.js";
import { acquireLock } from "./lock.js";
import { formatLocalDateTime, formatLocalTimestamp } from "./time.js";

const USAGE = `knowyou — an agent-agnostic background memory layer

Usage:
  knowyou scan     dry run: classify session files per harness (no LLM, no writes)
  knowyou run      real pipeline: scan → observe → consolidate → render
  knowyou status   pool/quota/watermark overview
  knowyou start    register the periodic job
  knowyou stop     unregister the periodic job`;

function localLastRun(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : formatLocalDateTime(date);
}

async function cmdScan(home: string): Promise<number> {
	const config = loadConfig(home);
	const state = loadState(home);
	return scanPhase(config, state).then((scan) => {
		const since = new Date(scan.cutoffMs);
		console.log(`knowyou scan — dry run (nothing written, no LLM calls)`);
		console.log(`window: last ${config.scan.windowDays} days (since ${formatLocalDateTime(since, false)})`);
		for (const harness of scan.harnesses) {
			const c = harness.counts;
			console.log(
				`${harness.name}: ${harness.sessions} sessions ` +
					`(candidates: ${c["candidate"]}, pending: ${c["pending"]}, noise: ${c["noise"]}, machine: ${c["machine"]}, unchanged: ${c["unchanged"]})`,
			);
		}
		for (const err of scan.errors) console.error(`error: ${err.file || err.harness}: ${err.error}`);
		return scan.errors.length > 0 ? 1 : 0;
	});
}

async function cmdRun(home: string): Promise<number> {
	// Whole-pipeline mutex: a consolidation's LLM call takes minutes, and a launchd
	// round overlapping a manual run would do concurrent read-modify-writes on
	// MEMORY.md + the pool (observations already deleted → memories erased).
	const release = acquireLock(home);
	if (!release) {
		console.log("another knowyou run is in progress — skipping this round");
		return 0;
	}
	try {
		return await runPipeline(home);
	} finally {
		release();
	}
}

async function runPipeline(home: string): Promise<number> {
	const config = loadConfig(home);
	const state = loadState(home);

	const scan = await scanPhase(config, state);
	const candidates = scan.harnesses.reduce((a, h) => a + h.counts["candidate"], 0);
	console.log(`scan: ${candidates} candidate session(s), ${scan.candidates.length} raw slice(s), ${scan.harnesses.reduce((a, h) => a + h.counts["pending"], 0)} pending, no LLM calls yet`);
	if (scan.errors.length > 0) for (const err of scan.errors) console.error(`scan error: ${err.file || err.harness}: ${err.error}`);

	const observe = await observePhase(config, home, state, scan);
	for (const obs of observe.observations) {
		console.log(`observation: ${obs.file} (${obs.chars} chars)`);
		console.log(`  ${obs.summary}`);
	}
	for (const err of observe.errors) console.error(`observe error: ${err.file}: ${err.error}`);
	const allErrors = [
		...scan.errors.map((e) => ({ file: e.file, error: e.error })),
		...observe.errors,
	];
	state.lastRun = {
		at: formatLocalTimestamp(new Date()),
		ok: allErrors.length === 0,
		errorCount: allErrors.length,
		lastError: allErrors[0]?.error,
	};
	saveState(home, state);
	if (observe.deferred) console.log(`deferred: ${observe.deferred} candidate(s) left for the next run (per-run cap)`);

	const consolidation = await runConsolidation(config, home);
	if (consolidation.triggered) {
		console.log(
			`consolidate: folded ${consolidation.folded} observation(s) — MEMORY.md ${consolidation.memoryChars}/${config.consolidate.maxMemoryChars} chars` +
				(consolidation.trimmed ? " (retry remained over quota; oldest prefix archived)" : consolidation.retried ? " (fit after one retry)" : ""),
		);
		if (consolidation.journalFile) console.log(`journal: ${consolidation.journalFile}`);
		for (const err of consolidation.errors) console.error(`consolidate error: ${err}`);
	} else {
		const pool = poolFiles(home).length;
		console.log(`consolidate: not triggered (pool ${pool}/${config.consolidate.triggerObservations})`);
	}
	saveState(home, state);

	const index = renderIndex(home);
	console.log(`INDEX.md: ${index.file} (${index.count} entries)`);
	return observe.errors.length > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
	const command = argv[0];
	const home = knowyouHome();

	if (command === "scan") return cmdScan(home);
	if (command === "run") return cmdRun(home);

	if (command === "status") {
		const config = loadConfig(home);
		const state = loadState(home);
		const sessions = Object.entries(state.sessions);
		const pending = sessions.filter(([, s]) => s.pending).length;
		const noise = sessions.filter(([, s]) => s.noise).length;
		console.log(`home: ${home}`);
		console.log(`tracked sessions: ${sessions.length} (pending: ${pending}, noise: ${noise})`);
		const obsDir = join(home, "observations");
		const obsCount = existsSync(obsDir) ? readdirSync(obsDir).filter((f) => f.endsWith(".md")).length : 0;
		console.log(`observations: ${obsCount}/${config.consolidate.triggerObservations}`);
		const memoryFile = join(home, "MEMORY.md");
		const memoryChars = existsSync(memoryFile) ? statSync(memoryFile).size : 0;
		console.log(`MEMORY.md: ${memoryChars}/${config.consolidate.maxMemoryChars} chars`);
		if (state.lastRun) {
			const lr = state.lastRun;
			console.log(
				lr.ok
					? `last run: ${localLastRun(lr.at)} — ok`
					: `last run: ${localLastRun(lr.at)} — FAILED (${lr.errorCount} errors, retrying next round)`,
			);
			if (lr.lastError) console.log(`  last error: ${lr.lastError.slice(0, 200)}`);
		} else {
			console.log("last run: never");
		}
		console.log(
			`schedule: every ${config.schedule.updateEverySeconds}s — ` +
				(isRegistered() ? "registered (launchd/cron active)" : "not registered (run 'knowyou start')"),
		);
		return 0;
	}

	if (command === "start") {
		const config = loadConfig(home);
		const result = scheduleStart();
		console.log(`scheduled: knowyou run every ${result.intervalSeconds}s (from config)`);
		console.log(`job: ${result.jobPath}`);
		console.log(`log: ${result.logPath}`);
		console.log(`config: ${join(home, "config.yaml")}`);
		void config;
		return 0;
	}

	if (command === "stop") {
		scheduleStop();
		console.log(`unscheduled (${plistPath()} removed on macOS)`);
		return 0;
	}

	console.log(USAGE);
	return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);
