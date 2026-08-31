import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeSession, readIncrement } from "../src/scan/pi-adapter.js";
import { compressEvents } from "../src/agents/observe-prompt.js";
import { runScan } from "../src/scan/scan.js";
import { loadState } from "../src/scan/state.js";
import { mergeConfig } from "../src/config.js";

/**
 * Tests against REAL session files (tests/fixtures/sessions/) — synthetic fixtures can't
 * cover the true pi session shape (thinking/toolCall blocks, model_change and custom
 * entries, nested content arrays). Fixtures are real user sessions, trimmed to small
 * files; they stay local to this repo.
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "sessions");
const RICH = join(FIXTURES, "real-rich.jsonl");
const SMALL = join(FIXTURES, "real-small.jsonl");

/** Real-shaped follow-up message (what pi appends on a resume/turn). */
function realMessage(role: string, text: string, withThinking = false): string {
	const content: unknown[] = [];
	if (withThinking) content.push({ type: "thinking", thinking: "internal reasoning that must not count" });
	content.push({ type: "text", text });
	return JSON.stringify({ type: "message", id: "test-msg", parentId: null, message: { role, content, stopReason: role === "assistant" ? "stop" : undefined } }) + "\n";
}

let home: string;
let storeRoot: string;
let savedEnv: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ky-real-home-"));
	storeRoot = mkdtempSync(join(tmpdir(), "ky-real-store-"));
	savedEnv = process.env["KNOWYOU_STORE_ROOTS"];
	process.env["KNOWYOU_STORE_ROOTS"] = join(storeRoot, "sessions");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(storeRoot, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env["KNOWYOU_STORE_ROOTS"];
	else process.env["KNOWYOU_STORE_ROOTS"] = savedEnv;
});

function fixtureStore(name: string): string {
	const dir = join(storeRoot, "sessions", "proj");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	copyFileSync(SMALL, file);
	utimesSync(file, new Date(), new Date()); // recent mtime — inside the 7-day window
	return file;
}

describe("adapter on real session files", () => {
	it("recognises a real session file", () => {
		expect(looksLikeSession(RICH)).toBe(true);
	});

	it("counts only message text on a real file — thinking/toolCall blocks and metadata excluded", () => {
		const inc = readIncrement(RICH, 0, false);
		const bytes = statSync(RICH).size;
		// Some real signal present…
		expect(inc.newChars).toBeGreaterThan(200);
		expect(inc.events.length).toBeGreaterThan(0);
		// …but far less than the raw file: thinking blocks, toolCall blocks, model_change,
		// thinking_level_change and entry metadata must all be excluded from the count.
		expect(inc.newChars).toBeLessThan(bytes / 2);
		for (const event of inc.events) {
			expect(["user", "assistant", "tool"]).toContain(event.role);
			expect(event.text).not.toMatch(/^\s*$/);
		}
		// Full read consumes the whole file (it ends with a complete newline).
		expect(inc.newOffset).toBe(bytes);
	});

	it("reads only the appended increment from a real file", () => {
		const file = join(storeRoot, "append-test.jsonl");
		copyFileSync(RICH, file);
		const first = readIncrement(file, 0, false);

		appendFileSync(file, realMessage("user", "REAL_INCREMENT_MARKER — this turn happened after the scan"));
		const second = readIncrement(file, first.newOffset, false);

		expect(second.events).toHaveLength(1);
		expect(second.events[0]?.role).toBe("user");
		expect(second.events[0]?.text).toContain("REAL_INCREMENT_MARKER");
		// The new region contains ONLY the new message — nothing from before the offset.
		expect(second.newChars).toBeLessThan(first.newChars);
		expect(second.newOffset).toBe(statSync(file).size);
	});

	it("strips control characters that would crash spawn argv", () => {
		const out = compressEvents([{ role: "tool", text: "before\u0000after\u0001tail" }]);
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).toContain("tail");
		expect(out).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
	});

	it("waits on a torn real-format line and absorbs it once the newline lands", () => {
		const file = join(storeRoot, "torn-test.jsonl");
		copyFileSync(RICH, file);
		const first = readIncrement(file, 0, false);

		appendFileSync(file, realMessage("assistant", "torn write", true).trimEnd()); // no trailing newline
		const torn = readIncrement(file, first.newOffset, false);
		expect(torn.newChars).toBe(0);
		expect(torn.newOffset).toBe(first.newOffset);

		appendFileSync(file, "\n"); // writer finishes the line
		const complete = readIncrement(file, first.newOffset, false);
		// Thinking block must not count; only the text block does.
		expect(complete.newChars).toBe("torn write".length);
		expect(complete.events[0]?.text).toBe("torn write");
	});
});

describe("scan pipeline on real session files", () => {
	const CONFIG = mergeConfig({
		scan: { minNewChars: 100, minUserTurns: 2, windowDays: 7 },
		limits: { maxObservationChars: 500 },
	});
	// Echo the chunk itself (not the surrounding prompt template) so assertions can
	// verify which conversation text actually reached the model.
	const FAKE_DISTILL = async (prompt: string) => {
		const chunk = prompt.split("Transcript slice:\n---\n")[1]?.replace(/\n---\s*$/, "") ?? "";
		return `SUMMARY: real-file observation\n\n${chunk}`;
	};

	it("distills a real file, then only its increment on the next round", async () => {
		const file = fixtureStore("real-small.jsonl");

		const first = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(first.observations).toHaveLength(1);
		const obs1 = first.observations[0]!.file;
		const text1 = readFileSync(obs1, "utf8");
		expect(text1).toContain(`source: ${file}`);
		const range1 = text1.match(/^range: (\d+)-(\d+)$/m)!;
		expect(Number(range1[2])).toBe(statSync(file).size); // absorbed to EOF

		// Rescan: unchanged, no new observation.
		const second = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });
		expect(second.observations).toHaveLength(0);
		expect(second.unchanged).toBe(1);

		// Real-format append (with a thinking block that must not count toward chars).
		// Text is long enough to cross the threshold on its own — increments are gated
		// independently, and this one must distill immediately.
		appendFileSync(
			file,
			realMessage("user", "FOLLOWUP_TURN about the deploy pipeline: " + "we settled on staging before production. ".repeat(3), true),
		);
		const third = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(third.observations).toHaveLength(1);
		const text2 = readFileSync(third.observations[0]!.file, "utf8");
		// Increment-only: the second observation's range starts where the first ended.
		const range2 = text2.match(/^range: (\d+)-(\d+)$/m)!;
		expect(Number(range2[1])).toBe(Number(range1[2]));
		expect(Number(range2[2])).toBe(statSync(file).size);
		expect(text2).toContain("FOLLOWUP_TURN");
		expect(readdirSync(join(home, "observations"))).toHaveLength(2);
	});

	it("skips real files outside the 7-day window", async () => {
		const file = fixtureStore("real-small.jsonl");
		const old = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(file, old, old);

		const report = await runScan(CONFIG, home, new Date(), { distill: FAKE_DISTILL });

		expect(report.filesSeen).toBe(1);
		expect(report.observations).toHaveLength(0);
		expect(existsSync(join(home, "observations")) ? readdirSync(join(home, "observations")) : []).toHaveLength(0);
		expect(Object.keys(loadState(home).sessions)).toHaveLength(0);
	});
});
