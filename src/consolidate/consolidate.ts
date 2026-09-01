import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { KnowyouConfig } from "../config.js";
import { runAgentPrompt } from "../agents/runner.js";
import { atomicWriteFileSync } from "../atomic.js";
import { buildConsolidationPrompt, type ConsolidationInput } from "./prompts.js";
import { formatLocalTimestamp } from "../time.js";

export interface ConsolidationReport {
	/** Whether the pool was over the threshold and consolidation ran. */
	triggered: boolean;
	/** All pending observations folded into MEMORY.md (pool files deleted). */
	folded: number;
	/** Final MEMORY.md size in chars — written as-is even when over quota. */
	memoryChars: number;
	overQuota: boolean;
	journalFile?: string;
	errors: string[];
}

export interface ConsolidateDeps {
	distill?: (prompt: string) => Promise<string>;
}

export function poolFiles(home: string): string[] {
	const dir = join(home, "observations");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort() // timestamp names sort chronologically — oldest first
		.map((name) => join(dir, name));
}

/**
 * Stage B — fold the entire observation pool into MEMORY.md. It is one shared-document
 * read/modify/write, so it is inherently serial. Nothing is deleted unless the new
 * MEMORY.md and journal are safely on disk; a failed call simply retries.
 */
export async function runConsolidation(
	config: KnowyouConfig,
	home: string,
	now = new Date(),
	deps: ConsolidateDeps = {},
): Promise<ConsolidationReport> {
	const report: ConsolidationReport = { triggered: false, folded: 0, memoryChars: 0, overQuota: false, errors: [] };

	const pool = poolFiles(home);
	const memoryFile = join(home, "MEMORY.md");
	const currentMemory = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "";
	// Two triggers: pool at its limit, OR MEMORY.md over its quota (the soft-budget
	// self-correction path — without this, an oversized MEMORY.md would never shrink
	// unless the pool happened to fill up again).
	const poolFull = pool.length >= config.consolidate.triggerObservations;
	const overQuota = currentMemory.length > config.consolidate.maxMemoryChars;
	if (!poolFull && !overQuota) return report;
	report.triggered = true;

	// Consolidation has no normal batch size: the whole compacted observation pool is the
	// context for one shared-memory read/modify/write. The observation cap and pool trigger
	// keep this bounded in ordinary operation.
	const batch = pool;

	const batchItems = batch.map((file) => {
		const raw = readFileSync(file, "utf8");
		const body = raw.startsWith("---") ? raw.slice(raw.indexOf("---", 3) + 3) : raw;
		const created = raw.match(/created: (.+)/)?.[1] ?? "";
		return { file, created, body: body.trim() };
	});

	const input: ConsolidationInput = {
		currentMemory,
		batch: batchItems.map(({ created, body }) => ({ file: "", created, body })),
		config,
	};
	const prompt = buildConsolidationPrompt(input);

	const distill =
		deps.distill ?? ((p: string) => runAgentPrompt({ prompt: p, model: config.agent.model, thinking: config.agent.thinking }));
	const raw = await distill(prompt);

	const memoryStart = raw.indexOf("===MEMORY===");
	const journalStart = raw.indexOf("===JOURNAL===");
	if (memoryStart === -1 || journalStart === -1 || journalStart < memoryStart) {
		report.errors.push("consolidation output missing ===MEMORY===/===JOURNAL=== markers");
		return report;
	}
	const newMemory = raw
		.slice(memoryStart + "===MEMORY===".length, journalStart)
		.trim();
	const journal = raw.slice(journalStart + "===JOURNAL===".length).trim();
	if (!newMemory) {
		report.errors.push("consolidation produced an empty MEMORY section");
		return report;
	}

	// Measure only — never modify the model's output. Overshoot is written as-is and
	// self-corrects: the next consolidation sees the over-quota percentage and shrinks.
	const memoryChars = newMemory.length;
	report.memoryChars = memoryChars;
	report.overQuota = memoryChars > config.consolidate.maxMemoryChars;

	// Crash-safe order: journal first, then MEMORY.md, then remove absorbed pool files.
	const journalsDir = join(home, "journals");
	mkdirSync(journalsDir, { recursive: true });
	if (journal && journal !== "-") {
		const pad = (n: number) => String(n).padStart(2, "0");
		const slug = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
		const journalFile = join(journalsDir, `${slug}.md`);
		atomicWriteFileSync(journalFile, `---\ncreated: ${formatLocalTimestamp(now)}\nfolded: ${batch.length}\n---\n${journal}\n`);
		report.journalFile = journalFile;
	}

	atomicWriteFileSync(memoryFile, `${newMemory}\n`);

	for (const file of batch) {
		try {
			unlinkSync(file);
		} catch (error) {
			// Non-fatal: an already-deleted file is fine; a delete failure just means the
			// file gets folded again next round (newest-wins merge absorbs the duplication).
			report.errors.push(`delete failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	report.folded = batch.length;
	return report;
}
