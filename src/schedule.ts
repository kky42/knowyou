import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knowyouHome, loadConfig } from "./config.js";

/**
 * Periodic-job registration. macOS: a LaunchAgents plist with StartInterval — the OS
 * owns scheduling, crash recovery and logs; knowyou itself never runs resident (the
 * scheduled command is one stateless `knowyou run`). Linux: a crontab line.
 */

export const LABEL = "ai.knowyou";

export function plistPath(): string {
	return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Absolute path of the compiled CLI — the plist cannot rely on PATH or a CWD. */
export function cliScriptPath(): string {
	const modulePath = fileURLToPath(import.meta.url); // .../dist/schedule.js (built) or .../src/schedule.ts (source)
	const inDist = modulePath.includes(`${"/"}dist${"/"}`) || modulePath.includes(`${"\\"}dist${"\\"}`);
	const script = inDist
		? join(dirname(modulePath), "cli.js")
		: join(dirname(dirname(modulePath)), "dist", "cli.js");
	if (!existsSync(script)) {
		throw new Error(`knowyou CLI not built — run "npm run build" first (expected at ${script})`);
	}
	return script;
}

export function buildPlist(opts: { nodePath: string; scriptPath: string; intervalSeconds: number; logPath: string }): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${opts.nodePath}</string>
		<string>${opts.scriptPath}</string>
		<string>run</string>
	</array>
	<key>StartInterval</key>
	<integer>${opts.intervalSeconds}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${opts.logPath}</string>
	<key>StandardErrorPath</key>
	<string>${opts.logPath}</string>
</dict>
</plist>
`;
}

function uid(): string {
	return String(process.getuid?.() ?? "");
}

function launchctl(args: string[]): void {
	execFileSync("launchctl", args, { stdio: "ignore" });
}

export function isRegistered(): boolean {
	if (process.platform === "darwin") {
		if (!existsSync(plistPath())) return false;
		try {
			launchctl(["print", `gui/${uid()}/${LABEL}`]);
			return true;
		} catch {
			return false;
		}
	}
	// Linux: the crontab entry is the registration.
	try {
		const crontab = execFileSync("crontab", ["-l"], { encoding: "utf8" });
		return crontab.includes(LABEL);
	} catch {
		return false;
	}
}

export function start(): { intervalSeconds: number; jobPath: string; logPath: string } {
	const config = loadConfig(knowyouHome());
	const home = knowyouHome();
	const intervalSeconds = config.schedule.updateEverySeconds;
	const logPath = join(home, "launchd.log");
	const scriptPath = cliScriptPath();
	const jobPath = plistPath();

	if (process.platform === "darwin") {
		mkdirSync(dirname(jobPath), { recursive: true });
		writeFileSync(
			jobPath,
			buildPlist({ nodePath: process.execPath, scriptPath, intervalSeconds, logPath }),
		);
		// bootout any stale registration before (re)bootstrap; ignore "not loaded" errors.
		try {
			launchctl(["bootout", `gui/${uid()}/${LABEL}`]);
		} catch {
			/* not loaded yet */
		}
		launchctl(["bootstrap", `gui/${uid()}`, jobPath]);
		return { intervalSeconds, jobPath, logPath };
	}

	// Linux: crontab line, keyed by the label for removal.
	try {
		const current = execFileSync("crontab", ["-l"], { encoding: "utf8" }).split("\n");
		const kept = current.filter((l) => !l.includes(LABEL));
		const cron = `*/${Math.max(1, Math.round(intervalSeconds / 60))} * * * * ${process.execPath} ${scriptPath} run >> ${logPath} 2>&1 # ${LABEL}`;
		kept.push(cron);
		writeFileSync(jobPath + ".cron", kept.join("\n") + "\n");
		execFileSync("crontab", [jobPath + ".cron"]);
	} finally {
		if (existsSync(jobPath + ".cron")) unlinkSync(jobPath + ".cron");
	}
	return { intervalSeconds, jobPath: "crontab", logPath };
}

export function stop(): void {
	if (process.platform === "darwin") {
		if (existsSync(plistPath())) {
			try {
				launchctl(["bootout", `gui/${uid()}/${LABEL}`]);
			} catch {
				/* not loaded */
			}
			unlinkSync(plistPath());
		}
		return;
	}
	try {
		const current = execFileSync("crontab", ["-l"], { encoding: "utf8" }).split("\n");
		const kept = current.filter((l) => !l.includes(LABEL));
		const tmp = join(knowyouHome(), ".crontab");
		mkdirSync(knowyouHome(), { recursive: true });
		writeFileSync(tmp, kept.join("\n") + "\n");
		execFileSync("crontab", [tmp]);
		unlinkSync(tmp);
	} catch {
		/* no crontab — nothing to remove */
	}
}
