import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type HarnessName = "pi" | "claude" | "codex" | "grok";

export interface KnowyouConfig {
  schedule: { updateEverySeconds: number };
  scan: {
    windowDays: number;
    minNewChars: number;
    minUserTurns: number;
    redactSecrets: boolean;
    harnesses: HarnessName[];
  };
  agent: { runner: "pi"; model: string; thinking: string; maxConcurrency: number };
  limits: {
    maxObservations: number;
    maxObservationChars: number;
    maxMemoryChars: number;
    consolidateBatchSize: number;
    /** Max candidates distilled in one run — cold-start token/cost control. */
    maxObservationsPerRun: number;
  };
}

export const DEFAULTS: KnowyouConfig = {
  schedule: { updateEverySeconds: 1800 },
  scan: {
    windowDays: 7,
    minNewChars: 40_000, // ~10K tokens
    minUserTurns: 2,
    redactSecrets: true,
    harnesses: ["pi"],
  },
  agent: { runner: "pi", model: "openai/gpt-5.6-luna", thinking: "low", maxConcurrency: 4 },
  limits: {
    maxObservations: 30,
    maxObservationChars: 500,
    maxMemoryChars: 20_000,
    consolidateBatchSize: 10,
    maxObservationsPerRun: 10,
  },
};

/**
 * Home dir override via KNOWYOU_HOME — used by tests to run against a temp dir
 * instead of the user's real ~/.knowyou.
 */
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

function mergeString(base: string, value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : base;
}

/** Deep-merge user config over defaults; unknown keys and bad types fall back to defaults. */
export function mergeConfig(raw: unknown): KnowyouConfig {
  if (!isRecord(raw)) return { ...DEFAULTS };
  const scan = isRecord(raw["scan"]) ? raw["scan"] : {};
  const agent = isRecord(raw["agent"]) ? raw["agent"] : {};
  const limits = isRecord(raw["limits"]) ? raw["limits"] : {};
  const schedule = isRecord(raw["schedule"]) ? raw["schedule"] : {};
  const harnesses = Array.isArray(scan["harnesses"])
    ? (scan["harnesses"].filter(
            (h): h is HarnessName => h === "pi" || h === "claude" || h === "codex" || h === "grok",
        ) as HarnessName[])
    : undefined;

  return {
    schedule: { updateEverySeconds: mergeNumber(DEFAULTS.schedule.updateEverySeconds, schedule["updateEverySeconds"]) },
    scan: {
      windowDays: mergeNumber(DEFAULTS.scan.windowDays, scan["windowDays"]),
      minNewChars: mergeNumber(DEFAULTS.scan.minNewChars, scan["minNewChars"]),
      minUserTurns: mergeNumber(DEFAULTS.scan.minUserTurns, scan["minUserTurns"]),
      redactSecrets: mergeBool(DEFAULTS.scan.redactSecrets, scan["redactSecrets"]),
      harnesses: harnesses && harnesses.length > 0 ? harnesses : [...DEFAULTS.scan.harnesses],
    },
    agent: {
      runner: "pi",
      model: mergeString(DEFAULTS.agent.model, agent["model"]),
      thinking: mergeString(DEFAULTS.agent.thinking, agent["thinking"]),
      maxConcurrency: mergeNumber(DEFAULTS.agent.maxConcurrency, agent["maxConcurrency"]),
    },
    limits: {
      maxObservations: mergeNumber(DEFAULTS.limits.maxObservations, limits["maxObservations"]),
      maxObservationChars: mergeNumber(DEFAULTS.limits.maxObservationChars, limits["maxObservationChars"]),
      maxMemoryChars: mergeNumber(DEFAULTS.limits.maxMemoryChars, limits["maxMemoryChars"]),
      consolidateBatchSize: mergeNumber(DEFAULTS.limits.consolidateBatchSize, limits["consolidateBatchSize"]),
      maxObservationsPerRun: mergeNumber(DEFAULTS.limits.maxObservationsPerRun, limits["maxObservationsPerRun"]),
    },
  };
}

export function loadConfig(home = knowyouHome()): KnowyouConfig {
  try {
    const raw = parseYaml(readFileSync(join(home, "config.yaml"), "utf8"));
    return mergeConfig(raw);
  } catch {
    return { ...DEFAULTS };
  }
}
