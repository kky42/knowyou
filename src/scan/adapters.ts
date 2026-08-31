import { existsSync, readdirSync, statSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import * as piAdapter from "./backpass/adapters/pi.js";
import * as claudeAdapter from "./backpass/adapters/claude.js";
import * as codexAdapter from "./backpass/adapters/codex.js";
import * as grokAdapter from "./backpass/adapters/grok.js";
import { contentToEvents, parseJsonLine } from "./backpass/adapters/shared.js";
import { classifyInteraction, emptyInteractionSignals } from "./backpass/interaction.js";
import { redactSecrets } from "./redact.js";
import type { MessageEvent } from "../observe/prompts.js";

/**
 * Glue between vendored backpass adapters (see backpass/README.md) and knowyou's
 * pipeline. Backpass re-reads whole transcripts; knowyou needs byte-offset increments,
 * so the region reading lives here and only the per-entry message mapping mirrors each
 * adapter's read() (marked below — keep in sync when updating vendored files).
 */

export interface CandidateInfo {
	path: string;
	mtimeMs: number;
	bytes: number;
}

export interface IncrementResult {
	events: MessageEvent[];
	userTurns: number;
	newChars: number;
	newOffset: number;
}

export interface HarnessAdapter {
	name: string;
	roots: string[];
	/** Files with mtime >= cutoffMs only — the time window is applied at enumeration. */
	enumerate(cutoffMs: number): CandidateInfo[];
	looksLikeSession(path: string): boolean;
	/** True for non-interactive machine sessions (codex exec, claude sdk, cron bridges) —
	 *  the self-exclusion half that --no-session cannot cover (other harnesses' runners). */
	isExcluded(path: string): boolean;
	readIncrement(path: string, offset: number, redact: boolean): IncrementResult;
}

/** Test/isolation override: scan ONLY these colon-separated roots. */
function storeRootsOverride(): string[] | undefined {
	const override = process.env["KNOWYOU_STORE_ROOTS"];
	if (!override) return undefined;
	return override.split(":").filter((p) => existsSync(p));
}

function statCandidate(file: string): CandidateInfo | undefined {
	try {
		const stat = statSync(file);
		return stat.isFile() ? { path: file, mtimeMs: stat.mtimeMs, bytes: stat.size } : undefined;
	} catch {
		return undefined;
	}
}

/** Generic one-level walk used when KNOWYOU_STORE_ROOTS overrides a harness's own roots. */
function genericEnumerate(root: string, cutoffMs: number): CandidateInfo[] {
	const out: CandidateInfo[] = [];
	const consider = (file: string) => {
		if (!file.endsWith(".jsonl")) return;
		const candidate = statCandidate(file);
		if (candidate && candidate.mtimeMs >= cutoffMs) out.push(candidate);
	};
	if (!existsSync(root)) return out;
	for (const name of readdirSync(root)) {
		const p = join(root, name);
		try {
			if (statSync(p).isDirectory()) {
				for (const inner of readdirSync(p)) consider(join(p, inner));
			} else {
				consider(p);
			}
		} catch {
			// raced deletion — skip
		}
	}
	return out;
}

function harnessAdapter(
	name: string,
	roots: string[],
	enumerateUpstream: (cutoffMs: number) => CandidateInfo[],
	classifyUpstream: (c: any) => any,
	/** Translates one store entry into raw backpass events — mirrors the vendored read(). */
	entryToEvents: (entry: any) => any[],
	/** Grok sessions are directories; the jsonl transcript lives inside. */
	transcriptPath: (path: string) => string = (p) => p,
): HarnessAdapter {
	const classifyCandidate = (path: string): any | undefined => {
		const stat = statCandidate(path);
		if (!stat) return undefined;
		try {
			// Backpass classify() signals "not a session" with null — normalise to undefined.
			return classifyUpstream(stat) ?? undefined;
		} catch {
			return undefined;
		}
	};

	return {
		name,
		roots,
		enumerate(cutoffMs: number): CandidateInfo[] {
			const override = storeRootsOverride();
			if (override) return override.flatMap((root) => genericEnumerate(root, cutoffMs));
			try {
				return enumerateUpstream(cutoffMs).filter((c) => c.mtimeMs >= cutoffMs);
			} catch {
				return [];
			}
		},
		looksLikeSession(path: string): boolean {
			return classifyCandidate(path) !== undefined;
		},
		isExcluded(path: string): boolean {
			const descriptor = classifyCandidate(path);
			if (!descriptor) return false;
			const verdict = classifyInteraction({
				harness: name,
				cwd: descriptor.cwd,
				interaction: descriptor.interaction,
				interactionSignals: descriptor.interactionSignals ?? descriptor.extra?.interactionSignals ?? emptyInteractionSignals(),
			});
			return verdict === "non-interactive";
		},
		readIncrement(path: string, offset: number, redact: boolean): IncrementResult {
			const jsonl = transcriptPath(path);
			const fd = openSync(jsonl, "r");
			try {
				const size = fstatSync(fd).size;
				// Truncated/rewritten file (size < offset): the old watermark points past EOF,
				// so re-read from the start — otherwise post-truncation turns are lost forever.
				const effectiveOffset = offset > size ? 0 : offset;
				if (size <= effectiveOffset) {
					return { events: [], userTurns: 0, newChars: 0, newOffset: Math.min(effectiveOffset, size) };
				}
				const buffer = Buffer.alloc(size - effectiveOffset);
				readSync(fd, buffer, 0, buffer.length, effectiveOffset);
				const lastNewline = buffer.lastIndexOf(0x0a);
				if (lastNewline === -1) return { events: [], userTurns: 0, newChars: 0, newOffset: effectiveOffset };
				const region = buffer.subarray(0, lastNewline + 1).toString("utf8");
				const newOffset = effectiveOffset + lastNewline + 1;

				const events: MessageEvent[] = [];
				let newChars = 0;
				let userTurns = 0;
				let lineStartByte = 0;
				for (const line of region.split("\n")) {
					const lineEndFileOffset = effectiveOffset + lineStartByte + Buffer.byteLength(line, "utf8") + 1;
					lineStartByte += Buffer.byteLength(line, "utf8") + 1;
					if (!line.trim()) continue;
					let entry: any;
					try {
						entry = parseJsonLine(line);
					} catch {
						continue;
					}
					if (!entry) continue;
					for (const raw of entryToEvents(entry)) {
						const text = raw.kind === "message" ? raw.text : raw.kind === "tool-result" ? raw.result : undefined;
						if (typeof text !== "string" || !text.trim()) continue;
						const clean = redact ? redactSecrets(text) : text;
						const role = raw.role === "user" ? "user" : raw.role === "assistant" ? "assistant" : "tool";
						newChars += clean.length;
						if (role === "user") userTurns += 1;
						events.push({ role, text: clean, endOffset: lineEndFileOffset });
					}
				}
				return { events, userTurns, newChars, newOffset };
			} finally {
				closeSync(fd);
			}
		},
	};
}

export const ADAPTERS: Record<string, HarnessAdapter> = {
	// Each entryToEvents mirrors the vendored adapter's read() — see backpass/README.md.
	pi: harnessAdapter(
		"pi",
		piAdapter.storeRoots(),
		(cutoff) => piAdapter.enumerate(),
		(c) => piAdapter.classify(c),
		(entry) => {
			const events: any[] = [];
			if (entry?.type !== "message" || !entry.message) return events;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") return events;
			contentToEvents(role, entry.message.content, events);
			return events;
		},
	),
	claude: harnessAdapter(
		"claude",
		claudeAdapter.storeRoots(),
		(cutoff) => claudeAdapter.enumerate(),
		(c) => claudeAdapter.classify(c),
		(entry) => {
			const events: any[] = [];
			if ((entry?.type === "user" || entry?.type === "assistant") && entry.message && !entry.isSidechain) {
				contentToEvents(entry.type, entry.message.content, events);
			}
			return events;
		},
	),
	codex: harnessAdapter(
		"codex",
		[codexAdapter.storeRoot()],
		(cutoff) => codexAdapter.enumerate({ cutoffMs: cutoff }),
		(c) => codexAdapter.classify(c),
		(entry) => {
			const events: any[] = [];
			if (entry?.type !== "response_item") return events;
			const payload = entry.payload || {};
			if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
				contentToEvents(payload.role, payload.content, events);
			} else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
				events.push({ kind: "tool-result", result: codexAdapter.flattenOutput(payload.output) });
			}
			return events;
		},
	),
	grok: harnessAdapter(
		"grok",
		[grokAdapter.storeRoot()],
		(cutoff) => grokAdapter.enumerate(),
		(c) => grokAdapter.classify(c),
		(entry) => {
			const events: any[] = [];
			switch (entry?.type) {
				case "user":
					contentToEvents("user", entry.content, events);
					break;
				case "assistant":
					contentToEvents("assistant", entry.content, events);
					break;
				case "tool_result":
					events.push({ kind: "tool-result", result: entry.content });
					break;
			}
			return events;
		},
		// Grok sessions are directories: the transcript is chat_history.jsonl inside.
		(path: string) => join(path, "chat_history.jsonl"),
	),
};

export function getAdapter(name: string): HarnessAdapter | undefined {
	return ADAPTERS[name];
}
