import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { knowyouHome, loadConfig } from "./config.js";
import { loadState } from "./scan/state.js";
import { runScan } from "./scan/scan.js";
import { renderIndex } from "./render/index-render.js";

const USAGE = `knowyou — an agent-agnostic background memory layer

Usage:
  knowyou scan     scan session stores and distill new observations (stage A + render)
  knowyou status   pool/quota/watermark overview
  knowyou start    register the periodic job (not implemented yet)
  knowyou stop     unregister the periodic job (not implemented yet)
  knowyou run      full pipeline (not implemented yet)`;

async function main(argv: string[]): Promise<number> {
	const command = argv[0];
	const home = knowyouHome();

	if (command === "scan") {
		const config = loadConfig(home);
		const report = await runScan(config, home);
		const index = renderIndex(home);
		console.log(`files seen: ${report.filesSeen} (unchanged: ${report.unchanged}, pending: ${report.pending}, noise: ${report.noise})`);
		for (const obs of report.observations) {
			console.log(`observation: ${obs.file} (${obs.chars} chars)`);
			console.log(`  ${obs.summary}`);
		}
		for (const err of report.errors) console.error(`error: ${err.file}: ${err.error}`);
		console.log(`INDEX.md: ${index.file} (${index.count} entries)`);
		return report.errors.length > 0 ? 1 : 0;
	}

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
		console.log(`schedule: every ${config.schedule.updateEverySeconds}s (registered: unknown — start/stop not implemented)`);
		return 0;
	}

	if (command === "start" || command === "stop" || command === "run") {
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
