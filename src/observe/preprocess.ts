import { redactSecrets } from "../scan/redact.js";
import { eventKind, type MessageEvent } from "../scan/events.js";
import { estimateTokens } from "../tokens.js";

// Adapted from Backpass's deterministic distillation stage. It intentionally has no model
// call: retain user/assistant signal, reduce tool chatter, remove harness boilerplate, and
// keep a bounded head/tail escape hatch for unusually long slices.
const TOOL_INPUT_CHARS = 160;
const TOOL_OUTPUT_CHARS = 200;
const MESSAGE_CHARS = 6000;
// Keeps a typical 20K–80K raw slice compact enough that a four-slice observe batch
// remains comfortable for ordinary model context windows. This is an internal safety
// cap, not another user-facing batching knob.
export const DEFAULT_COMPACTED_TOKENS = 3000;

const BOILERPLATE = [
	/^<system-reminder>/,
	/^<user_info>/,
	/^<recommended_plugins>/,
	/^<permissions instructions>/,
	/^<env>/,
	/^Caveat: The messages below were generated/,
];

export interface PreprocessedTrace {
	text: string;
	estimatedTokens: number;
	elided: boolean;
}

function oneLine(value: unknown, limit: number): string {
	const flat = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function stripControls(text: string): string {
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function clampMessage(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MESSAGE_CHARS) return trimmed;
	const head = trimmed.slice(0, MESSAGE_CHARS - 1200);
	const tail = trimmed.slice(-1000);
	return `${head}\n\n[... ${trimmed.length - MESSAGE_CHARS} chars elided ...]\n\n${tail}`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function describeToolInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	if (typeof input === "string") return oneLine(input, TOOL_INPUT_CHARS);
	if (typeof input === "object") {
		for (const key of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description"]) {
			const value = (input as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return oneLine(value, TOOL_INPUT_CHARS);
		}
	}
	return oneLine(safeStringify(input), TOOL_INPUT_CHARS);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function describeToolResult(result: unknown): string {
	if (result === null || result === undefined) return "";
	const text = typeof result === "string" ? result : safeStringify(result);
	const bytes = Buffer.byteLength(text, "utf8");
	const summary = oneLine(text, TOOL_OUTPUT_CHARS);
	return bytes > TOOL_OUTPUT_CHARS ? `${summary} (output ${formatBytes(bytes)}, truncated)` : summary;
}

function isBoilerplate(text: string): boolean {
	const trimmed = text.trim();
	return !trimmed || BOILERPLATE.some((pattern) => pattern.test(trimmed));
}

function sliceUtf8(text: string, maxBytes: number, fromEnd = false): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = fromEnd ? text.slice(text.length - mid) : text.slice(0, mid);
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return fromEnd ? text.slice(text.length - low) : text.slice(0, low);
}

function capTrace(body: string, maxTokens: number): { text: string; elided: boolean } {
	if (estimateTokens(body) <= maxTokens) return { text: body, elided: false };

	const budgetBytes = maxTokens * 4;
	const head = sliceUtf8(body, Math.floor(budgetBytes * 0.43));
	const tail = sliceUtf8(body, Math.floor(budgetBytes * 0.43), true);
	const droppedTokens = Math.max(0, estimateTokens(body) - estimateTokens(head) - estimateTokens(tail));
	let text = `${head}\n\n[... middle elided: ~${droppedTokens} tokens ...]\n\n${tail}`;
	if (estimateTokens(text) > maxTokens) text = sliceUtf8(text, budgetBytes);
	return { text, elided: true };
}

/** Deterministically compact one raw scan slice before it reaches the observation model. */
export function preprocessEvents(events: MessageEvent[], maxTokens = DEFAULT_COMPACTED_TOKENS): PreprocessedTrace {
	const lines: string[] = [];
	let turn = 0;
	for (const event of events) {
		if (eventKind(event) === "message") {
			const text = redactSecrets(clampMessage(stripControls(event.text ?? "")));
			if (!text || isBoilerplate(text)) continue;
			turn += 1;
			lines.push(`### turn ${turn} · ${event.role ?? "unknown"}`, text, "");
			continue;
		}

		const input = redactSecrets(stripControls(describeToolInput(event.input)));
		const result = redactSecrets(stripControls(describeToolResult(event.result)));
		const status = event.status && event.status !== "completed" ? ` [${event.status}]` : "";
		const arrow = result ? ` -> ${result}` : "";
		lines.push(`tool: ${event.name ?? "unknown"}${input ? ` ${JSON.stringify(input)}` : ""}${status}${arrow}`);
	}

	const capped = capTrace(lines.join("\n").trim(), maxTokens);
	return { text: capped.text, estimatedTokens: estimateTokens(capped.text), elided: capped.elided };
}
