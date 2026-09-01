import { estimateTokensFromBytes } from "../tokens.js";

/**
 * Normalized session events. The optional fields keep the adapter boundary tolerant of
 * legacy tests and harness records while preserving Backpass's tool-call shape.
 */
export interface MessageEvent {
	kind?: "message" | "tool";
	role?: "user" | "assistant" | "tool";
	text?: string;
	name?: string;
	input?: unknown;
	result?: unknown;
	status?: string;
	/** Byte offset just past the source JSONL line containing this event. */
	endOffset?: number;
}

export function eventKind(event: MessageEvent): "message" | "tool" {
	return event.kind ?? (event.role === "tool" ? "tool" : "message");
}

export function isUserMessage(event: MessageEvent): boolean {
	return eventKind(event) === "message" && event.role === "user";
}

function stringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Raw normalized content used for scan thresholds, before Backpass-style compaction. */
export function eventRawText(event: MessageEvent): string {
	if (eventKind(event) === "message") return event.text ?? "";
	return [event.name ?? "tool", stringify(event.input), stringify(event.result), event.status].filter(Boolean).join(" ");
}

export function eventBytes(event: MessageEvent): number {
	return Buffer.byteLength(eventRawText(event), "utf8");
}

export function eventTokens(event: MessageEvent): number {
	return estimateTokensFromBytes(eventBytes(event));
}
