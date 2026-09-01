import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readdirSync, utimesSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "../src/pipeline.js";
import { loadState } from "../src/scan/state.js";
import { mergeConfig } from "../src/config.js";
import { formatLocalTimestamp } from "../src/time.js";

/**
 * Orchestration tests for runScan's filter branches — the unit tests in scan.test.ts
 * cover the adapter mechanics; these cover the time window, noise filter, threshold
 * gating with fragment accumulation, and unchanged-file skipping, using an injected
 * fake distill (no real model calls).
 */

let home: string;
let storeRoot: string;
let store: string;
let sessionFile: string;
let savedEnv: string | undefined;

const CONFIG = mergeConfig({
	scan: { minNewTokens: 25, minUserTurns: 2, windowDays: 7, harnesses: ["pi"] },
	observe: { maxObservationChars: 500 },
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

const FAKE_DISTILL = async (prompt: string) => `SUMMARY: fake summary\n\n${prompt.slice(-100)}`;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ky-home-"));
	storeRoot = mkdtempSync(join(tmpdir(), "ky-store-"));
	store = join(storeRoot, "sessions", "proj");
	mkdirSync(store, { recursive: true });
	sessionFile = join(store, "s1.jsonl");
	// Isolate from the real session store — enumerate() must only see the fixture.
	savedEnv = process.env["KNOWYOU_STORE_ROOTS"];
	process.env["KNOWYOU_STORE_ROOTS"] = join(storeRoot, "sessions");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(storeRoot, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env["KNOWYOU_STORE_ROOTS"];
	else process.env["KNOWYOU_STORE_ROOTS"] = savedEnv;
});

describe("runScan orchestration filters", () => {
	it("skips files older than the time window entirely", async () => {
		writeSession(line({ type: "session", cwd: "/x", id: "s1" }) + message("user", "x".repeat(300)) + message("assistant", "y"));
		const old = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(sessionFile, old, old);

		const report = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		// The window filter lives inside the adapters' enumerate — old files are never
		// returned at all, so nothing is seen, tracked, or distilled.
		expect(report.filesSeen).toBe(0);
		expect(report.observations).toHaveLength(0);
		expect(existsSync(join(home, "observations"))).toBe(true);
		expect(readdirSync(join(home, "observations"))).toHaveLength(0);
		// Not even tracked — the window cut it before any processing.
		expect(Object.keys(loadState(home).sessions)).toHaveLength(0);
	});

	it("marks few-turn sessions as noise and does not distill them", async () => {
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "x".repeat(300)) +
				message("assistant", "y".repeat(300)),
		);

		const report = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(report.noise).toBe(1);
		expect(report.observations).toHaveLength(0);
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.noise).toBe(true);
		// The offset must NOT advance: once the session qualifies (turn 2+), the whole
		// unabsorbed region — including the opening turn — gets distilled.
		expect(entry?.offset).toBe(0);
	});

	it("keeps sub-threshold increments pending and accumulates them into the next round", async () => {
		// 2 user turns (not noise), but only ~60 message chars — below the 100-char threshold.
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "short") +
				message("assistant", "ok") +
				message("user", "tiny"),
		);

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
		// The observation covers the WHOLE accumulated file (range starts at 0), and its
		// body carries the appended content (the fake distill echoes the prompt tail).
		const obsDir = join(home, "observations");
		expect(readdirSync(obsDir)).toHaveLength(1);
		const obsText = readFileSync(join(obsDir, readdirSync(obsDir)[0]!), "utf8");
		expect(obsText).toMatch(/^range: 0-\d+$/m);
		expect(obsText).toContain("xxx");
	});

	it("batches multiple raw slices from one session into one observation", async () => {
		const sliced = mergeConfig({
			scan: { minNewTokens: 40, maxNewTokens: 80, minUserTurns: 2, windowDays: 7, harnesses: ["pi"] },
			observe: { batchSize: 4, maxSlicesPerRun: 10 },
		});
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "u".repeat(120)) +
				message("assistant", "a".repeat(120)) +
				message("user", "v".repeat(120)) +
				message("assistant", "b".repeat(120)) +
				message("user", "w".repeat(120)) +
				message("assistant", "c".repeat(120)),
		);
		let calls = 0;
		let observedPrompt = "";
		const report = await runScan(sliced, home, new Date(), {
			distill: async (prompt) => {
				calls += 1;
				observedPrompt = prompt;
				return "SUMMARY: batched\n\nthree related slices";
			},
		});
		expect(report.observations).toHaveLength(1);
		expect(calls).toBe(1);
		expect(observedPrompt).toContain("slice 0");
		expect(observedPrompt).toContain("slice 1");
		expect(observedPrompt).toContain("slice 2");
		const state = loadState(home);
		expect(state.sessions[sessionFile]?.offset).toBe(state.sessions[sessionFile]?.bytes);
	});

	it("skips unchanged files on rescan without re-distilling", async () => {
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "x".repeat(300)) +
				message("assistant", "y".repeat(300)) +
				message("user", "second turn"),
		);
		// 2 user turns — passes the noise filter, crosses the threshold.
		const now = new Date("2026-01-02T03:04:05.678Z");
		const first = await runScan(CONFIG, home, now, { distill: FAKE_DISTILL });
		expect(first.observations).toHaveLength(1);

		const observation = readFileSync(join(home, "observations", readdirSync(join(home, "observations"))[0]!), "utf8");
		expect(observation).toContain(`created: ${formatLocalTimestamp(now)}`);
		expect(loadState(home).lastRun?.at).toBe(formatLocalTimestamp(now));

		const second = await runScan(CONFIG, home, now, { distill: FAKE_DISTILL });
		expect(second.unchanged).toBe(1);
		expect(second.observations).toHaveLength(0);
		expect(readdirSync(join(home, "observations"))).toHaveLength(1);
	});

	it("does not advance the watermark when distillation fails, so the increment retries", async () => {
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "x".repeat(300)) +
				message("assistant", "y".repeat(300)) +
				message("user", "second turn"),
		);

		const failing = async () => {
			throw new Error("model unavailable");
		};
		const report = await runScan(CONFIG, home, new Date(), { distill: failing });

		expect(report.errors).toHaveLength(1);
		// Watermark untouched: no entry (⇒ offset 0) — the increment retries next round.
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.offset ?? 0).toBe(0);

		// Next round with a working model succeeds on the same content.
		const retried = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(retried.observations).toHaveLength(1);
	});
});

describe("last-run bookkeeping", () => {
	function seedQualifyingSession(): void {
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "x".repeat(300)) +
				message("assistant", "y".repeat(300)) +
				message("user", "second turn"),
		);
	}

	it("records failures in state so knowyou status can surface them", async () => {
		seedQualifyingSession();
		const failing = async () => {
			throw new Error("quota exhausted");
		};
		await runScan(CONFIG, home, new Date(), { distill: failing });
		const state = loadState(home);
		expect(state.lastRun?.ok).toBe(false);
		expect(state.lastRun?.errorCount).toBe(1);
		expect(state.lastRun?.lastError).toContain("quota exhausted");
	});

	it("clears to ok on a successful retry", async () => {
		seedQualifyingSession();
		const failing = async () => {
			throw new Error("quota exhausted");
		};
		await runScan(CONFIG, home, new Date(), { distill: failing });
		await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		const state = loadState(home);
		expect(state.lastRun?.ok).toBe(true);
		expect(state.observations ?? {}).toBeDefined();
	});
});

describe("no-new-info protocol", () => {
	it("absorbs the increment without writing an observation when the model reports nothing new", async () => {
		writeSession(
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "x".repeat(300)) +
				message("assistant", "y".repeat(300)) +
				message("user", "second turn"),
		);
		const nothingNew = async () => "SUMMARY: no new information\n\n-";
		const report = await runScan(CONFIG, home, new Date(), { distill: nothingNew });

		expect(report.observations).toHaveLength(0);
		expect(report.skipped).toBe(1);
		// Watermark advanced — the increment is consumed even though nothing was recorded.
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.offset).toBe(entry?.bytes);
		expect(existsSync(join(home, "observations"))).toBe(true);
		expect(readdirSync(join(home, "observations"))).toHaveLength(0);
	});
});

describe("per-run cap and serial batching", () => {
	function seedSessions(count: number): void {
		for (let i = 0; i < count; i++) {
			const f = join(store, `s${i}.jsonl`);
			writeFileSync(
				f,
				line({ type: "session", cwd: "/x", id: `s${i}` }) +
					message("user", `content ${i} `.repeat(30)) +
					message("assistant", "y".repeat(120)) +
					message("user", "second turn"),
			);
			// Distinct recent mtimes, oldest first for s0 (inside the 7-day window).
			const t = Date.now() - 6 * 86_400_000 + i * 1000;
			utimesSync(f, new Date(t), new Date(t));
		}
	}

	it("processes at most maxSlicesPerRun slices, oldest first, deferring the rest", async () => {
		seedSessions(5);
		const capped = mergeConfig({
			scan: { minNewTokens: 25, minUserTurns: 2, windowDays: 7, harnesses: ["pi"] },
			observe: { maxSlicesPerRun: 2, batchSize: 1 },
		});
		let calls = 0;
		const counting = async (prompt: string) => {
			calls += 1;
			return `SUMMARY: obs ${calls}\n\n${prompt.slice(-80)}`;
		};

		const first = await runScan(capped, home, new Date(), { distill: counting });
		expect(first.observations).toHaveLength(2);
		expect(first.deferred).toBe(3);

		// Oldest-first: the two oldest files were distilled.
		const oldest = readFileSync(join(store, "s0.jsonl"), "utf8").includes("content 0");
		expect(oldest).toBe(true);
		// Deferred candidates are untouched — their watermarks stay empty.
		expect(loadState(home).sessions[join(store, "s4.jsonl")]).toBeUndefined();

		// Next run picks up the deferred ones.
		const second = await runScan(capped, home, new Date(), { distill: counting });
		expect(second.observations).toHaveLength(2);
		expect(second.deferred).toBe(1);
	});

	it("batches up to four slices and processes batches serially", async () => {
		seedSessions(6);
		const limited = mergeConfig({
			scan: { minNewTokens: 25, minUserTurns: 2, windowDays: 7, harnesses: ["pi"] },
			observe: { maxSlicesPerRun: 10, batchSize: 4 },
		});
		let active = 0;
		let peak = 0;
		let calls = 0;
		const tracking = async (prompt: string) => {
			calls += 1;
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 15));
			active -= 1;
			return `SUMMARY: obs\n\n${prompt.slice(-80)}`;
		};

		const report = await runScan(limited, home, new Date(), { distill: tracking });
		expect(report.observations).toHaveLength(2);
		expect(calls).toBe(2);
		expect(peak).toBe(1);
	});
});
