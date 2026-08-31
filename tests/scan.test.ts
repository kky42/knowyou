import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/scan/adapters.js";

const pi = getAdapter("pi")!;
import { fileUnchanged, loadState, saveState } from "../src/scan/state.js";
import { compressEvents, parseObservation } from "../src/observe/prompts.js";
import { mergeConfig } from "../src/config.js";

function sessionLine(obj: unknown): string {
	return JSON.stringify(obj) + "\n";
}

function message(role: string, text: string): string {
	return sessionLine({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

describe("pi adapter: increment reading", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "knowyou-test-"));
		file = join(dir, "session.jsonl");
		writeFileSync(
			file,
			sessionLine({ type: "session", cwd: "/tmp/x", id: "s1" }) +
				message("user", "hello world ".repeat(50)) +
				message("assistant", "hi there ".repeat(50)),
		);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads the full file from offset 0 and returns message chars", () => {
		const inc = pi.readIncrement(file, 0, false);
		expect(inc.userTurns).toBe(1);
		expect(inc.newChars).toBeGreaterThan(500);
		expect(inc.events).toHaveLength(2);
		expect(inc.events[0]?.role).toBe("user");
		expect(inc.newOffset).toBe(Buffer.byteLength(readFileSync(file, "utf8")));
	});

	it("aligns to the last complete newline when a torn line is appended", () => {
		const first = pi.readIncrement(file, 0, false);
		// A torn line: valid JSON but no trailing newline yet (writer mid-write).
		appendFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "partial line without newline" }] } }));
		const second = pi.readIncrement(file, first.newOffset, false);
		// The torn line is not a complete newline yet — nothing absorbable.
		expect(second.newChars).toBe(0);
		expect(second.newOffset).toBe(first.newOffset);
	});

	it("sees appended complete lines on the next read", () => {
		const first = pi.readIncrement(file, 0, false);
		appendFileSync(file, message("user", "a follow-up turn"));
		const second = pi.readIncrement(file, first.newOffset, false);
		expect(second.events).toHaveLength(1);
		expect(second.events[0]?.text).toContain("follow-up");
		expect(second.newOffset).toBe(Buffer.byteLength(readFileSync(file, "utf8")));
	});

	it("excludes thinking blocks and non-message entries from the count", () => {
		const file2 = join(dir, "s2.jsonl");
		writeFileSync(
			file2,
			sessionLine({ type: "session", cwd: "/tmp/x", id: "s2" }) +
				message("assistant", "visible answer") +
				sessionLine({ type: "message", message: { role: "assistant", content: [{ type: "thinking", text: "secret reasoning ".repeat(100) }] } }) +
				sessionLine({ type: "custom", customType: "om.something", data: {} }),
		);
		const inc = pi.readIncrement(file2, 0, false);
		expect(inc.newChars).toBe("visible answer".length);
	});

	it("redacts secrets when asked", () => {
		const file3 = join(dir, "s3.jsonl");
		writeFileSync(file3, sessionLine({ type: "session", cwd: "/x", id: "s3" }) + message("user", "my key is sk-abcdefghijklmnopqrstuvwx"));
		const inc = pi.readIncrement(file3, 0, true);
		expect(inc.events[0]?.text).toContain("[REDACTED]");
		expect(inc.events[0]?.text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
	});

	it("validates session header", () => {
		expect(pi.looksLikeSession(file)).toBe(true);
		const notSession = join(dir, "other.jsonl");
		writeFileSync(notSession, '{"type":"other"}\n');
		expect(pi.looksLikeSession(notSession)).toBe(false);
	});
});

describe("state watermarks", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "knowyou-state-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("persists and reloads watermarks", () => {
		const state = loadState(dir);
		state.sessions["/a.jsonl"] = { bytes: 10, mtimeMs: 20, offset: 10, userTurns: 3, noise: false, pending: true, chunks: 1 };
		saveState(dir, state);
		const reloaded = loadState(dir);
		expect(reloaded.sessions["/a.jsonl"]?.offset).toBe(10);
		expect(reloaded.sessions["/a.jsonl"]?.pending).toBe(true);
	});

	it("detects unchanged files", () => {
		const entry = { bytes: 100, mtimeMs: 200, offset: 100, userTurns: 2, noise: false, pending: false, chunks: 1 };
		expect(fileUnchanged(entry, 200, 100)).toBe(true);
		expect(fileUnchanged(entry, 201, 100)).toBe(false);
		expect(fileUnchanged(undefined, 200, 100)).toBe(false);
	});
});

describe("observation parsing", () => {
	it("extracts summary and enforces the char cap", () => {
		const raw = "SUMMARY: Fixed the flaky test\n\nWe fixed it by mocking time. " + "x".repeat(2000);
		const parsed = parseObservation(raw, 500);
		expect(parsed.summary).toBe("Fixed the flaky test");
		expect(parsed.body.length).toBeLessThanOrEqual(500);
	});

	it("falls back to first line when SUMMARY prefix is missing", () => {
		const parsed = parseObservation("just a body", 500);
		expect(parsed.summary).toBe("just a body");
	});
});

describe("config merge", () => {
	it("keeps defaults on garbage and overrides on valid values", () => {
		const defaults = mergeConfig(undefined);
		expect(defaults.scan.minNewChars).toBe(40_000);
		const merged = mergeConfig({ scan: { minNewChars: 5 }, limits: { maxMemoryChars: 999 } });
		expect(merged.scan.minNewChars).toBe(5);
		expect(merged.limits.maxMemoryChars).toBe(999);
		expect(merged.limits.maxObservations).toBe(30);
		const bad = mergeConfig({ scan: { minNewChars: "lots" }, agent: { model: "" } });
		expect(bad.scan.minNewChars).toBe(40_000);
		expect(bad.agent.model).toBe("openai/gpt-5.6-luna");
	});
});
