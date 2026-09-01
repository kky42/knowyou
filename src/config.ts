import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type HarnessName = "pi" | "claude" | "codex" | "grok";

export interface KnowyouConfig {
	schedule: { updateEverySeconds: number };
	scan: {
		windowDays: number;
		minNewTokens: number;
		maxNewTokens: number;
		minUserTurns: number;
		redactSecrets: boolean;
		harnesses: HarnessName[];
	};
	observe: {
		maxObservationChars: number;
		/** Maximum raw slices handled in one scheduled run; zero is not allowed. */
		maxSlicesPerRun: number;
	};
	agent: { runner: "pi"; model?: string; thinking?: string };
	consolidate: {
		/** Number of observations that triggers a consolidation call. */
		triggerObservations: number;
		maxMemoryChars: number;
	};
}

export const DEFAULTS: KnowyouConfig = {
	schedule: { updateEverySeconds: 1800 },
	scan: {
		windowDays: 7,
		minNewTokens: 20_000,
		maxNewTokens: 200_000,
		minUserTurns: 2,
		redactSecrets: true,
		harnesses: ["pi", "codex", "claude", "grok"],
	},
	observe: {
		maxObservationChars: 500,
		maxSlicesPerRun: 10,
	},
	agent: { runner: "pi" },
	consolidate: {
		triggerObservations: 30,
		maxMemoryChars: 20_000,
	},
};

/** Home dir override via KNOWYOU_HOME — used by tests to run against a temp dir. */
export function knowyouHome(): string {
	return process.env["KNOWYOU_HOME"] ?? join(homedir(), ".knowyou");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function mergeNumber(base: number, value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : base;
}

function mergeBool(base: boolean, value: unknown): boolean {
	return typeof value === "boolean" ? value : base;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Deep-merge user config over defaults. Legacy 0.1.0 keys remain readable. */
export function mergeConfig(raw: unknown): KnowyouConfig {
	if (!isRecord(raw)) return structuredClone(DEFAULTS);
	const scan = isRecord(raw["scan"]) ? raw["scan"] : {};
	const observe = isRecord(raw["observe"]) ? raw["observe"] : {};
	const agent = isRecord(raw["agent"]) ? raw["agent"] : {};
	const consolidate = isRecord(raw["consolidate"]) ? raw["consolidate"] : {};
	const limits = isRecord(raw["limits"]) ? raw["limits"] : {};
	const harnesses = Array.isArray(scan["harnesses"])
		? (scan["harnesses"].filter((h): h is HarnessName => h === "pi" || h === "claude" || h === "codex" || h === "grok") as HarnessName[])
		: undefined;

	const legacyMinChars = scan["minNewChars"];
	const legacyMinTokens = typeof legacyMinChars === "number" && Number.isFinite(legacyMinChars) && legacyMinChars > 0 ? Math.ceil(legacyMinChars / 4) : undefined;
	const minNewTokens = mergeNumber(DEFAULTS.scan.minNewTokens, scan["minNewTokens"] ?? legacyMinTokens);

	return {
		schedule: { updateEverySeconds: mergeNumber(DEFAULTS.schedule.updateEverySeconds, (raw["schedule"] as Record<string, unknown> | undefined)?.["updateEverySeconds"]) },
		scan: {
			windowDays: mergeNumber(DEFAULTS.scan.windowDays, scan["windowDays"]),
			minNewTokens,
			maxNewTokens: mergeNumber(DEFAULTS.scan.maxNewTokens, scan["maxNewTokens"]),
			minUserTurns: mergeNumber(DEFAULTS.scan.minUserTurns, scan["minUserTurns"]),
			redactSecrets: mergeBool(DEFAULTS.scan.redactSecrets, scan["redactSecrets"]),
			harnesses: harnesses && harnesses.length > 0 ? harnesses : [...DEFAULTS.scan.harnesses],
		},
		observe: {
			maxObservationChars: mergeNumber(
				DEFAULTS.observe.maxObservationChars,
				observe["maxObservationChars"] ?? limits["maxObservationChars"],
			),
			maxSlicesPerRun: mergeNumber(
				DEFAULTS.observe.maxSlicesPerRun,
				observe["maxSlicesPerRun"] ?? limits["maxObservationsPerRun"],
			),
		},
		agent: {
			runner: "pi",
			model: optionalString(agent["model"]),
			thinking: optionalString(agent["thinking"]),
		},
		consolidate: {
			triggerObservations: mergeNumber(
				DEFAULTS.consolidate.triggerObservations,
				consolidate["triggerObservations"] ?? limits["maxObservations"],
			),
			maxMemoryChars: mergeNumber(DEFAULTS.consolidate.maxMemoryChars, consolidate["maxMemoryChars"] ?? limits["maxMemoryChars"]),
		},
	};
}

export function loadConfig(home = knowyouHome()): KnowyouConfig {
	try {
		const raw = parseYaml(readFileSync(join(home, "config.yaml"), "utf8"));
		return mergeConfig(raw);
	} catch {
		return structuredClone(DEFAULTS);
	}
}
