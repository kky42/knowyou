import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConsolidation, poolFiles } from "../src/consolidate/consolidate.js";
import { mergeConfig } from "../src/config.js";
import { formatLocalTimestamp } from "../src/time.js";

let home: string;

const CONFIG = mergeConfig({
	limits: { maxObservations: 5, consolidateBatchSize: 3, maxMemoryChars: 20000 },
});

function seedPool(count: number): void {
	const dir = join(home, "observations");
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		const pad = String(i).padStart(2, "0");
		writeFileSync(
			join(dir, `2026-08-31-10-00-${pad}.md`),
			`---\ncreated: 2026-08-31T10:00:${pad}Z\nsource: /s${i}.jsonl\nrange: 0-100\n---\nSummary ${i}\n\nFact number ${i}: the detail worth keeping.\n`,
		);
	}
}

function foldingDistill(memory: string, journal = "-") {
	return async (prompt: string) => {
		// Sanity: the prompt must carry the current memory and the batch facts.
		expect(prompt).toContain("Fact number");
		return `===MEMORY===\n${memory}\n===JOURNAL===\n${journal}`;
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ky-cons-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("consolidation", () => {
	it("does not trigger under the pool threshold", async () => {
		seedPool(4); // threshold 5 → triggers only at >= 5
		let called = 0;
		const report = await runConsolidation(CONFIG, home, new Date(), {
			distill: async () => {
				called += 1;
				return "===MEMORY===\nx\n===JOURNAL===\n-";
			},
		});
		expect(report.triggered).toBe(false);
		expect(called).toBe(0);
	});

	it("folds the oldest batch, writes MEMORY.md, deletes absorbed pool files", async () => {
		seedPool(7); // threshold 5, batch 3 → fold 3 oldest, pool drops to 4
		const report = await runConsolidation(CONFIG, home, new Date(), {
			distill: foldingDistill("# Memory\n\n- Fact number 0 merged."),
		});

		expect(report.triggered).toBe(true);
		expect(report.folded).toBe(3);
		expect(report.memoryChars).toBeGreaterThan(0);
		expect(report.overQuota).toBe(false);
		expect(poolFiles(home)).toHaveLength(4);
		// The OLDEST files were folded (deleted), newer ones remain.
		expect(existsSync(join(home, "observations", "2026-08-31-10-00-00.md"))).toBe(false);
		expect(existsSync(join(home, "observations", "2026-08-31-10-00-00.md").replace("00.md", "06.md"))).toBe(true);
		expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toContain("Fact number 0 merged.");
	});

	it("writes a journal file when the model evicts content", async () => {
		seedPool(7);
		const now = new Date("2026-01-02T03:04:05.678Z");
		const report = await runConsolidation(CONFIG, home, now, {
			distill: foldingDistill("# Memory\n\ncondensed.", "archived: old deploy notes from 2026-08-01"),
		});
		expect(report.journalFile).toBeDefined();
		expect(readFileSync(report.journalFile!, "utf8")).toContain("archived: old deploy notes");
		expect(readFileSync(report.journalFile!, "utf8")).toContain(`created: ${formatLocalTimestamp(now)}`);
		expect(readdirSync(join(home, "journals"))).toHaveLength(1);
	});

	it("accepts over-quota output as-is — measured, never modified", async () => {
		seedPool(7);
		const huge = "# Memory\n\n" + "over budget line. ".repeat(2000); // ~37K chars > 20K quota
		const report = await runConsolidation(CONFIG, home, new Date(), { distill: foldingDistill(huge) });

		expect(report.overQuota).toBe(true);
		// Written verbatim — no truncation, no retry-mangling. The file holds the model's
		// output (plus a single trailing newline we add); size matches what was reported.
		const written = readFileSync(join(home, "MEMORY.md"), "utf8");
		expect(written).toContain(huge.slice(0, 100));
		expect(report.memoryChars).toBe(written.trim().length);
		expect(report.memoryChars).toBeGreaterThan(CONFIG.limits.maxMemoryChars);
		expect(poolFiles(home)).toHaveLength(4); // absorbed regardless
	});

	it("fails the round (pool untouched) when the output has no markers", async () => {
		seedPool(7);
		const report = await runConsolidation(CONFIG, home, new Date(), {
			distill: async () => "I folded everything nicely but forgot the markers.",
		});
		expect(report.errors).toHaveLength(1);
		expect(poolFiles(home)).toHaveLength(7); // nothing deleted — retried next round
		expect(existsSync(join(home, "MEMORY.md"))).toBe(false);
	});
});
