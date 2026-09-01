import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAdapter } from "../src/scan/adapters.js";
import { splitScanSlices } from "../src/scan/scan.js";

const pi = getAdapter("pi")!;
import { fileUnchanged, loadState, saveState } from "../src/scan/state.js";
import { parseObservation } from "../src/observe/prompts.js";
import { estimateTokensFromBytes } from "../src/tokens.js";
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
		expect(inc.newTokens).toBe(estimateTokensFromBytes(inc.newBytes));
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

	it("keeps a tool call with its later result and intervening lines", () => {
		const withTool = join(dir, "tool.jsonl");
		writeFileSync(
			withTool,
			sessionLine({ type: "session", cwd: "/tmp/x", id: "tool" }) +
				sessionLine({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "cat", arguments: { path: "README.md" } }] } }) +
				message("user", "while the tool runs") +
				sessionLine({ type: "message", message: { role: "toolResult", content: [{ type: "toolResult", tool_use_id: "call-1", content: "README contents" }] } }),
		);
		const inc = pi.readIncrement(withTool, 0, false);
		const tool = inc.events.find((event) => event.kind === "tool");
		const user = inc.events.find((event) => event.role === "user");
		expect(tool?.result).toBe("README contents");
		expect(tool?.endOffset).toBe(user?.endOffset);
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
		expect(pi.classify(file)).toBe("interactive");
		const notSession = join(dir, "other.jsonl");
		writeFileSync(notSession, '{"type":"other"}\n');
		expect(pi.classify(notSession)).toBe("invalid");
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

describe("raw token-bounded scan slices", () => {
	it("splits at complete event lines and preserves byte ranges", () => {
		const events = [
			{ kind: "message" as const, role: "user" as const, text: "a".repeat(200), endOffset: 100 },
			{ kind: "message" as const, role: "assistant" as const, text: "b".repeat(200), endOffset: 200 },
			{ kind: "message" as const, role: "user" as const, text: "c".repeat(200), endOffset: 300 },
		];
		const slices = splitScanSlices(events, 0, 300, 80);
		expect(slices).toHaveLength(3);
		expect(slices.map((slice) => [slice.startOffset, slice.endOffset])).toEqual([
			[0, 100],
			[100, 200],
			[200, 300],
		]);
		expect(slices.every((slice) => slice.rawTokens >= 50 && slice.rawTokens <= 80)).toBe(true);
	});

	it("keeps multiple events from one JSONL record together", () => {
		const events = [
			{ kind: "message" as const, role: "user" as const, text: "a".repeat(120), endOffset: 100 },
			{ kind: "message" as const, role: "assistant" as const, text: "b".repeat(120), endOffset: 100 },
			{ kind: "message" as const, role: "user" as const, text: "c".repeat(120), endOffset: 200 },
		];
		const slices = splitScanSlices(events, 0, 200, 40);
		expect(slices[0]?.events).toHaveLength(2);
		expect(slices[0]?.endOffset).toBe(100);
	});

	it("keeps a short prefix with the next slice and leaves a short tail pending", () => {
		const events = [
			{ kind: "message" as const, role: "user" as const, text: "a".repeat(60), endOffset: 100 },
			{ kind: "message" as const, role: "assistant" as const, text: "b".repeat(280), endOffset: 200 },
			{ kind: "message" as const, role: "user" as const, text: "c".repeat(60), endOffset: 300 },
		];
		const slices = splitScanSlices(events, 0, 300, 80, 20);
		expect(slices).toHaveLength(1);
		expect(slices[0]?.rawTokens).toBe(85);
		expect(slices[0]?.endOffset).toBe(200);
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
		expect(defaults.scan.minNewTokens).toBe(20_000);
		expect(defaults.scan.maxNewTokens).toBe(200_000);
		expect(defaults.scan.harnesses).toEqual(["pi", "codex", "claude", "grok"]);
		const merged = mergeConfig({ scan: { minNewTokens: 5 }, consolidate: { maxMemoryChars: 999 } });
		expect(merged.scan.minNewTokens).toBe(5);
		const selected = mergeConfig({ scan: { harnesses: ["codex"] } });
		expect(selected.scan.harnesses).toEqual(["codex"]);
		expect(merged.consolidate.maxMemoryChars).toBe(999);
		expect(merged.consolidate.triggerObservations).toBe(30);
		const bad = mergeConfig({ scan: { minNewTokens: "lots" }, agent: { model: "" } });
		expect(bad.scan.minNewTokens).toBe(20_000);
		expect(bad.agent.model).toBeUndefined();
		expect(bad.agent.thinking).toBeUndefined();
		const configured = mergeConfig({ agent: { model: "openai/gpt-5.6-luna", thinking: "high" } });
		expect(configured.agent.model).toBe("openai/gpt-5.6-luna");
		expect(configured.agent.thinking).toBe("high");
	});
});
