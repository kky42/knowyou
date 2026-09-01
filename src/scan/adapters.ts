import { existsSync, readdirSync, statSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import * as piAdapter from "./backpass/adapters/pi.js";
import * as claudeAdapter from "./backpass/adapters/claude.js";
import * as codexAdapter from "./backpass/adapters/codex.js";
import * as grokAdapter from "./backpass/adapters/grok.js";
import { attachToolResults, contentToEvents, parseJsonLine } from "./backpass/adapters/shared.js";
import { classifyInteraction, emptyInteractionSignals } from "./backpass/interaction.js";
import { redactSecrets } from "./redact.js";
import { eventRawText, eventBytes, isUserMessage, type MessageEvent } from "./events.js";
import { estimateTokensFromBytes } from "../tokens.js";

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
	/** Legacy display metric retained for diagnostics; thresholds use newTokens. */
	newChars: number;
	newBytes: number;
	newTokens: number;
	newOffset: number;
}

export interface HarnessAdapter {
	name: string;
	roots: string[];
	/** Files with mtime >= cutoffMs only — the time window is applied at enumeration. */
	enumerate(cutoffMs: number): CandidateInfo[];
	/** Classify once per scan; adapters may need to read session metadata from disk. */
	classify(path: string): "interactive" | "non-interactive" | "invalid";
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
		const chatPath = transcriptPath(path);
		const stat = statCandidate(chatPath);
		if (!stat) return undefined;
		try {
			// Backpass classify() signals "not a session" with null — normalise to undefined.
			return classifyUpstream({ ...stat, path, chatPath }) ?? undefined;
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
		classify(path: string): "interactive" | "non-interactive" | "invalid" {
			const descriptor = classifyCandidate(path);
			if (!descriptor) return "invalid";
			const verdict = classifyInteraction({
				harness: name,
				cwd: descriptor.cwd,
				interaction: descriptor.interaction,
				interactionSignals: descriptor.interactionSignals ?? descriptor.extra?.interactionSignals ?? emptyInteractionSignals(),
			});
			return verdict === "non-interactive" ? "non-interactive" : "interactive";
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
					return { events: [], userTurns: 0, newChars: 0, newBytes: 0, newTokens: 0, newOffset: Math.min(effectiveOffset, size) };
				}
				const buffer = Buffer.alloc(size - effectiveOffset);
				readSync(fd, buffer, 0, buffer.length, effectiveOffset);
				const lastNewline = buffer.lastIndexOf(0x0a);
				if (lastNewline === -1) return { events: [], userTurns: 0, newChars: 0, newBytes: 0, newTokens: 0, newOffset: effectiveOffset };
				const region = buffer.subarray(0, lastNewline + 1).toString("utf8");
				const newOffset = effectiveOffset + lastNewline + 1;

				const rawEvents: any[] = [];
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
						if (!raw || typeof raw !== "object") continue;
						const event = { ...raw, endOffset: lineEndFileOffset };
						if (typeof event.text === "string") event.text = redact ? redactSecrets(event.text) : event.text;
						if (typeof event.result === "string") event.result = redact ? redactSecrets(event.result) : event.result;
						rawEvents.push(event);
					}
				}

				// Backpass associates tool results with their calls. Extend the call's source
				// range through the result line so a raw slice never consumes the call while
				// leaving its result for a later watermark.
				const toolsById = new Map<string, any>();
				for (const raw of rawEvents) {
					if (raw.kind === "tool" && raw.pendingId) toolsById.set(raw.pendingId, raw);
				}
				for (const raw of rawEvents) {
					if (raw.kind !== "tool-result" || !raw.id) continue;
					const tool = toolsById.get(raw.id);
					if (tool && typeof tool.endOffset === "number" && typeof raw.endOffset === "number") {
						tool.endOffset = Math.max(tool.endOffset, raw.endOffset);
					}
				}
				// A call can now reach past intervening transcript lines to its result. Keep
				// effective boundaries monotonic so those lines stay in the same contiguous
				// slice and a watermark never skips over them.
				let contiguousEnd = effectiveOffset;
				for (const raw of rawEvents) {
					if (typeof raw.endOffset !== "number") continue;
					contiguousEnd = Math.max(contiguousEnd, raw.endOffset);
					raw.endOffset = contiguousEnd;
				}

				const events: MessageEvent[] = attachToolResults(rawEvents).flatMap((raw: any): MessageEvent[] => {
					if (raw.kind === "message" && (raw.role === "user" || raw.role === "assistant")) {
						return [{ kind: "message", role: raw.role, text: raw.text ?? "", endOffset: raw.endOffset }];
					}
					if (raw.kind === "message" && raw.role === "toolResult") {
						return [{ kind: "tool", role: "tool", name: "tool-result", result: raw.text ?? "", endOffset: raw.endOffset }];
					}
					if (raw.kind === "tool") {
						return [{
							kind: "tool",
							role: "tool",
							name: raw.name,
							input: raw.input,
							result: raw.result,
							status: raw.status,
							endOffset: raw.endOffset,
						}];
					}
					return [];
				});
				const newBytes = events.reduce((total, event) => total + eventBytes(event), 0);
				const newChars = events.reduce((total, event) => total + eventRawText(event).length, 0);
				const userTurns = events.filter(isUserMessage).length;
				return { events, userTurns, newChars, newBytes, newTokens: estimateTokensFromBytes(newBytes), newOffset };
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
			} else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
				events.push({
					kind: "tool",
					name: payload.name,
					input: parseMaybeJson(payload.arguments ?? payload.input),
					pendingId: payload.call_id,
				});
			} else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
				events.push({ kind: "tool-result", id: payload.call_id, result: codexAdapter.flattenOutput(payload.output) });
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
					for (const call of entry.tool_calls || []) {
						events.push({
							kind: "tool",
							name: call.name,
							input: parseMaybeJson(call.arguments ?? call.input),
							pendingId: call.id,
						});
					}
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

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export function getAdapter(name: string): HarnessAdapter | undefined {
	return ADAPTERS[name];
}
