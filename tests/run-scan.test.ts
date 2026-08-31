import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readdirSync, utimesSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../src/scan/scan.js";
import { loadState } from "../src/scan/state.js";
import { mergeConfig } from "../src/config.js";

/**
 * Orchestration tests for runScan's filter branches — the unit tests in scan.test.ts
 * cover the adapter mechanics; these cover the time window, noise filter, threshold
 * gating with fragment accumulation, and unchanged-file skipping, using an injected
 * fake distill (no real model calls).
 */

let home: string;
let store: string;
let sessionFile: string;

const CONFIG = mergeConfig({
	scan: { minNewChars: 100, minUserTurns: 2, windowDays: 7 },
	limits: { maxObservationChars: 500 },
});

function writeSession(content: string): void {
	writeFileSync(sessionFile, content);
}

function line(obj: unknown): string {
	return JSON.stringify(obj) + "\n";
}

function message(role: string, text: string): string {
	return line({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

const FAKE_DISTILL = async (prompt: string) => `SUMMARY: fake summary\n\n${prompt.slice(0, 50)}`;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ky-home-"));
	store = join(mkdtempSync(join(tmpdir(), "ky-store-")), "sessions", "proj");
	mkdirSync(store, { recursive: true });
	sessionFile = join(store, "s1.jsonl");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	const storeRoot = join(store, "..", "..");
	rmSync(storeRoot, { recursive: true, force: true });
});

describe("runScan orchestration filters", () => {
	it("skips files older than the time window entirely", async () => {
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "x".repeat(300)) + message("assistant", "y"));
		const old = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(sessionFile, old, old);

		const report = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(report.filesSeen).toBe(1);
		expect(report.observations).toHaveLength(0);
		expect(existsSync(join(home, "observations"))).toBe(true);
		expect(readdirSync(join(home, "observations"))).toHaveLength(0);
		// Not even tracked — the window cut it before any processing.
		expect(Object.keys(loadState(home).sessions)).toHaveLength(0);
	});

	it("marks few-turn sessions as noise and does not distill them", async () => {
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "x".repeat(300)) + message("assistant", "y".repeat(300)));

		const report = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(report.noise).toBe(1);
		expect(report.observations).toHaveLength(0);
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.noise).toBe(true);
		expect(entry?.offset).toBe(entry?.bytes); // skipped to EOF
	});

	it("keeps sub-threshold increments pending and accumulates them into the next round", async () => {
		// 2 user turns (not noise), but only ~60 message chars — below the 100-char threshold.
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "short") + message("assistant", "ok"));

		const first = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(first.pending).toBe(1);
		expect(first.observations).toHaveLength(0);

		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.pending).toBe(true);
		expect(entry?.offset).toBe(0); // watermark NOT advanced — fragments accumulate

		// More content arrives; combined increment now crosses the threshold.
		appendFileSync(sessionFile, message("user", "x".repeat(200)));
		const second = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(second.observations).toHaveLength(1);
		const distilled = loadState(home).sessions[sessionFile];
		expect(distilled?.offset).toBe(distilled?.bytes); // fully absorbed
		expect(distilled?.pending).toBe(false);
		// The observation file exists and carries the accumulated content.
		const obsDir = join(home, "observations");
		expect(readdirSync(obsDir)).toHaveLength(1);
		expect(readFileSync(join(obsDir, readdirSync(obsDir)[0]!), "utf8")).toContain("short");
	});

	it("skips unchanged files on rescan without re-distilling", async () => {
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "x".repeat(300)) + message("assistant", "y".repeat(300)));
		// 2 user turns — passes the noise filter, crosses the threshold.
		const first = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(first.observations).toHaveLength(1);

		const second = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(second.unchanged).toBe(1);
		expect(second.observations).toHaveLength(0);
		expect(readdirSync(join(home, "observations"))).toHaveLength(1);
	});

	it("does not advance the watermark when distillation fails, so the increment retries", async () => {
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "x".repeat(300)) + message("assistant", "y".repeat(300)));

		const failing = async () => {
			throw new Error("model unavailable");
		};
		const report = await runScan(CONFIG, home, new Date(), { distill: failing });

		expect(report.errors).toHaveLength(1);
		expect(loadState(home).sessions[sessionFile]?.offset).toBe(0);

		// Next round with a working model succeeds on the same content.
		const retried = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(retried.observations).toHaveLength(1);
	});
});
