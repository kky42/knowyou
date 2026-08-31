import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { knowyouHome, loadConfig } from "./config.js";
import { loadState, saveState } from "./scan/state.js";
import { scanPhase, observePhase } from "./scan/scan.js";
import { renderIndex } from "./render/index-render.js";

const USAGE = `knowyou — an agent-agnostic background memory layer

Usage:
  knowyou scan     dry run: classify session files per harness (no LLM, no writes)
  knowyou run      real pipeline: scan → observe → consolidate(TODO) → render
  knowyou status   pool/quota/watermark overview
  knowyou start    register the periodic job (not implemented yet)
  knowyou stop     unregister the periodic job (not implemented yet)`;

async function cmdScan(home: string): Promise<number> {
	const config = loadConfig(home);
	const state = loadState(home);
	return scanPhase(config, state).then((scan) => {
		const since = new Date(scan.cutoffMs);
		console.log(`knowyou scan — dry run (nothing written, no LLM calls)`);
		console.log(`window: last ${config.scan.windowDays} days (since ${since.toISOString().slice(0, 16).replace("T", " ")})`);
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
	const config = loadConfig(home);
	const state = loadState(home);

	const scan = await scanPhase(config, state);
	const candidates = scan.harnesses.reduce((a, h) => a + h.counts["candidate"], 0);
	console.log(`scan: ${candidates} candidate(s), ${scan.harnesses.reduce((a, h) => a + h.counts["pending"], 0)} pending, no LLM calls yet`);
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
		at: new Date().toISOString(),
		ok: allErrors.length === 0,
		errorCount: allErrors.length,
		lastError: allErrors[0]?.error,
	};
	saveState(home, state);

	// Consolidation (stage B) not yet implemented.
	const obsDir = join(home, "observations");
	const pool = existsSync(obsDir) ? readdirSync(obsDir).filter((f) => f.endsWith(".md")).length : 0;
	console.log(`consolidate: not implemented yet (pool ${pool}/${config.limits.maxObservations})`);

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
		console.log(`observations: ${obsCount}/${config.limits.maxObservations}`);
		const memoryFile = join(home, "MEMORY.md");
		const memoryChars = existsSync(memoryFile) ? statSync(memoryFile).size : 0;
		console.log(`MEMORY.md: ${memoryChars}/${config.limits.maxMemoryChars} chars`);
		if (state.lastRun) {
			const lr = state.lastRun;
			console.log(
				lr.ok
					? `last run: ${lr.at.slice(0, 19).replace("T", " ")} — ok`
					: `last run: ${lr.at.slice(0, 19).replace("T", " ")} — FAILED (${lr.errorCount} errors, retrying next round)`,
			);
			if (lr.lastError) console.log(`  last error: ${lr.lastError.slice(0, 200)}`);
		} else {
			console.log("last run: never");
		}
		console.log(`schedule: every ${config.schedule.updateEverySeconds}s (registered: unknown — start/stop not implemented)`);
		return 0;
	}

	if (command === "start" || command === "stop") {
		console.error(`knowyou ${command}: not implemented yet`);
		return 2;
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
