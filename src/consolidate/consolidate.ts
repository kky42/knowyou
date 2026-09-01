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
	/** Final MEMORY.md size in chars after retry and deterministic fallback enforcement. */
	memoryChars: number;
	overQuota: boolean;
	/** True when the first model output exceeded the quota and was regenerated. */
	retried?: boolean;
	/** True when the second output still exceeded quota and was deterministically trimmed. */
	trimmed?: boolean;
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

function parseOutput(raw: string): { memory: string; journal: string } | undefined {
	const memoryStart = raw.indexOf("===MEMORY===");
	const journalStart = raw.indexOf("===JOURNAL===");
	if (memoryStart === -1 || journalStart === -1 || journalStart < memoryStart) return undefined;
	const memory = raw.slice(memoryStart + "===MEMORY===".length, journalStart).trim();
	if (!memory) return undefined;
	return { memory, journal: raw.slice(journalStart + "===JOURNAL===".length).trim() };
}

function retainTail(memory: string, maxChars: number): { memory: string; removed: string } {
	if (memory.length <= maxChars) return { memory, removed: "" };
	const cut = memory.length - maxChars;
	const nextLine = memory.indexOf("\n", cut);
	const boundary = nextLine === -1 ? cut : nextLine + 1;
	return { memory: memory.slice(boundary), removed: memory.slice(0, boundary).trim() };
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
	// Two triggers: pool at its limit, OR a pre-existing MEMORY.md over its quota.
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
	let raw = await distill(prompt);
	let parsed = parseOutput(raw);
	if (!parsed) {
		report.errors.push("consolidation output missing ===MEMORY===/===JOURNAL=== markers");
		return report;
	}

	if (parsed.memory.length > config.consolidate.maxMemoryChars) {
		report.retried = true;
		raw = await distill(
			`Your previous MEMORY section was ${parsed.memory.length} characters, exceeding the hard limit of ${config.consolidate.maxMemoryChars}. Regenerate the complete result once, preserving important recent information while staying within the limit.\n\n${prompt}`,
		);
		parsed = parseOutput(raw);
		if (!parsed) {
			report.errors.push("consolidation retry output missing ===MEMORY===/===JOURNAL=== markers");
			return report;
		}
	}

	let newMemory = parsed.memory;
	let journal = parsed.journal;
	if (newMemory.length > config.consolidate.maxMemoryChars) {
		const retained = retainTail(newMemory, config.consolidate.maxMemoryChars);
		newMemory = retained.memory;
		const overflowArchive = `## Quota overflow archive\n\n${retained.removed}`;
		journal = journal && journal !== "-" ? `${journal}\n\n${overflowArchive}` : overflowArchive;
		report.trimmed = true;
	}

	const memoryChars = newMemory.length;
	report.memoryChars = memoryChars;
	report.overQuota = false;

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
