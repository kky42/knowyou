import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.js";
import { atomicWriteFileSync } from "../src/atomic.js";
import { redactSecrets } from "../src/scan/redact.js";
import { MAX_COMPACTED_TOKENS, preprocessEvents } from "../src/observe/preprocess.js";
import { buildObservationPrompt } from "../src/observe/prompts.js";
import { estimateTokens } from "../src/tokens.js";
import type { MessageEvent } from "../src/scan/events.js";
import { runScan } from "../src/pipeline.js";
import { loadState } from "../src/scan/state.js";
import { mergeConfig } from "../src/config.js";

let home: string;
let storeRoot: string;
let store: string;
let sessionFile: string;
let savedEnv: string | undefined;

const CONFIG = mergeConfig({
	scan: { minNewTokens: 25, minUserTurns: 2, windowDays: 7, harnesses: ["pi"] },
	observe: { maxObservationChars: 500 },
});

function line(obj: unknown): string {
	return JSON.stringify(obj) + "\n";
}

function message(role: string, text: string): string {
	return line({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ky-lock-"));
	storeRoot = mkdtempSync(join(tmpdir(), "ky-store-"));
	store = join(storeRoot, "sessions", "proj");
	mkdirSync(store, { recursive: true });
	sessionFile = join(store, "s1.jsonl");
	savedEnv = process.env["KNOWYOU_STORE_ROOTS"];
	process.env["KNOWYOU_STORE_ROOTS"] = join(storeRoot, "sessions");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(storeRoot, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env["KNOWYOU_STORE_ROOTS"];
	else process.env["KNOWYOU_STORE_ROOTS"] = savedEnv;
});

describe("pipeline lock", () => {
	it("blocks a second holder while the first is alive", () => {
		const release = acquireLock(home);
		expect(release).toBeDefined();
		expect(acquireLock(home)).toBeUndefined();
		release!();
		expect(acquireLock(home)).toBeDefined();
	});

	it("steals a stale lock left by a dead process (crash recovery)", () => {
		writeFileSync(join(home, ".lock"), "999999999");
		const release = acquireLock(home);
		expect(release).toBeDefined();
		expect(readFileSync(join(home, ".lock"), "utf8")).toBe(String(process.pid));
		release!();
	});

	it("does not steal a lock owned by a live process", () => {
		writeFileSync(join(home, ".lock"), String(process.pid));
		expect(acquireLock(home)).toBeUndefined();
	});
});

describe("atomic writes", () => {
	it("replaces content and leaves no temp files behind", () => {
		const file = join(home, "MEMORY.md");
		writeFileSync(file, "old");
		atomicWriteFileSync(file, "new");
		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(home).filter((f) => f.includes(".tmp"))).toHaveLength(0);
	});
});

describe("redaction of unquoted env/shell assignments", () => {
	it("redacts unquoted password and AWS secret key assignments", () => {
		const text = ["PASSWORD=supersecret123", "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "DB_PASSWORD='quoted-pass-123'"].join("\n");
		const out = redactSecrets(text);
		expect(out).not.toContain("supersecret123");
		expect(out).not.toContain("wJalrXUtnFEMI");
		expect(out).not.toContain("quoted-pass-123");
		expect(out).toContain("[REDACTED]");
	});
});

	describe("Backpass-style preprocessing", () => {
		it("keeps conversation signal, collapses tools, and enforces a token cap", () => {
			const events: MessageEvent[] = [
				{ kind: "message", role: "user", text: "Decide the deployment strategy." },
				{ kind: "tool", role: "tool", name: "Bash", input: { command: "npm test" }, result: "all tests passed" },
				{ kind: "message", role: "assistant", text: "Use staging before production." },
			];
			const compacted = preprocessEvents(events, 100);
			expect(compacted.text).toContain("Decide the deployment strategy.");
			expect(compacted.text).toContain("tool: Bash");
			expect(compacted.text).toContain("npm test");
			expect(compacted.estimatedTokens).toBeLessThanOrEqual(100);
			const bounded = preprocessEvents([{ kind: "message", role: "assistant", text: "x".repeat(10000) }], 20);
			expect(bounded.elided).toBe(true);
			expect(bounded.estimatedTokens).toBeLessThanOrEqual(20);
		});

		it("caps one default observation trace at 10K estimated tokens", () => {
			const events = Array.from({ length: 12 }, (_, index): MessageEvent => ({
				kind: "message",
				role: index % 2 === 0 ? "user" : "assistant",
				text: `${index}:` + "signal ".repeat(1500),
			}));
			const compacted = preprocessEvents(events);
			expect(compacted.elided).toBe(true);
			expect(compacted.estimatedTokens).toBeLessThanOrEqual(MAX_COMPACTED_TOKENS);
			const prompt = buildObservationPrompt(
				{
					harness: "codex",
					path: `/workspace/${"p".repeat(1000)}/session.jsonl`,
					sequence: 0,
					startOffset: 0,
					endOffset: 800_000,
					rawTokens: 200_000,
					compactedTokens: compacted.estimatedTokens,
					text: compacted.text,
				},
				500,
			);
			expect(estimateTokens(prompt)).toBeLessThan(12_000);
		});
	});

	describe("increment absorption", () => {
		it("absorbs an increment end to end — offset advances to the real EOF", async () => {
		writeFileSync(
			sessionFile,
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "u1 ") +
				message("assistant", "a1 ") +
				message("user", "u2 " + "z".repeat(300)) +
				"\n",
			);
		const report = await runScan(CONFIG, home, new Date(), { distill: async (p) => `SUMMARY: s\n\n${p.slice(-80)}` });
		expect(report.errors).toHaveLength(0);
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.offset).toBe(entry?.bytes);
		});
	});

describe("malformed model output", () => {
	it("rejects blank output: error reported, increment not absorbed (retried next round)", async () => {
		writeFileSync(
			sessionFile,
			line({ type: "session", cwd: "/x", id: "s1" }) +
				message("user", "u1 ") +
				message("assistant", "a1 ") +
				message("user", "u2 " + "z".repeat(300)) +
				"\n",
			);
		const report = await runScan(CONFIG, home, new Date(), { distill: async () => "" });
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].error).toContain("not absorbed");
		const entry = loadState(home).sessions[sessionFile];
		expect(entry?.offset ?? 0).toBe(0);
		expect(readdirSync(join(home, "observations"))).toHaveLength(0);
	});
});
