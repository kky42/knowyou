export interface MessageEvent {
	role: "user" | "assistant" | "tool";
	text: string;
}

const PER_MESSAGE_CAP: Record<MessageEvent["role"], number> = { user: 4000, assistant: 4000, tool: 300 };
const TOTAL_CAP = 80_000;

/**
 * Deterministic pre-compression before any LLM sees the increment — the backpass
 * distiller's shape: keep user/assistant turns nearly verbatim, collapse tool output to
 * short lines. Recent turns matter more, so an over-cap region keeps its tail.
 */
export function compressEvents(events: MessageEvent[]): string {
	const lines = events.map((event) => {
		const cap = PER_MESSAGE_CAP[event.role];
		const text = event.text.length > cap ? event.text.slice(0, cap) + " …[truncated]" : event.text;
		return `## ${event.role}\n${text}`;
	});
	const joined = lines.join("\n\n");
	if (joined.length <= TOTAL_CAP) return joined;
	// Walk from the tail accumulating events until over cap, then keep that suffix.
	const kept: string[] = [];
	let total = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line === undefined) continue;
		total += line.length + 2;
		if (total > TOTAL_CAP) break;
		kept.unshift(line);
	}
	return kept.join("\n\n");
}

const PROMPT_TEMPLATE = `You distill observations from a slice of an AI coding-agent session transcript. The slice may be a continuation of earlier context you cannot see.

Rules:
- First line: "SUMMARY: " followed by ONE sentence (max 100 chars) capturing the most important thing in this slice.
- Then a blank line, then the body: factual, atomic notes — what was done, decided, learned, or is in progress.
- Record outcomes and decisions, not play-by-play. Conflicting statements: the latest one reflects current state.
- Body must be at most {MAX_CHARS} characters. Write in the language the conversation uses.
- Never include API keys, tokens, or credentials. Never speculate beyond the transcript.

Transcript slice:
---
{CHUNK}
---`;

export function buildObservationPrompt(chunk: string, maxObservationChars: number): string {
	return PROMPT_TEMPLATE.replace("{MAX_CHARS}", String(maxObservationChars)).replace("{CHUNK}", chunk);
}

export interface ParsedObservation {
	summary: string;
	body: string;
}

/**
 * Parse the model output into (summary, body) and enforce the char cap — the hard limit
 * is ours to enforce, never the model's to promise.
 */
export function parseObservation(raw: string, maxObservationChars: number): ParsedObservation {
	const text = raw.trim();
	const lines = text.split("\n");
	const firstLine = lines[0] ?? "";
	let summary: string;
	let bodyStart = 0;
	if (firstLine.startsWith("SUMMARY:")) {
		summary = firstLine.slice("SUMMARY:".length).trim();
		bodyStart = 1;
	} else {
		summary = firstLine.slice(0, 100);
	}
	const body = lines.slice(bodyStart).join("\n").trim();
	const capped = body.length > maxObservationChars ? truncateAtSentence(body, maxObservationChars) : body;
	return { summary, body: capped };
}

function truncateAtSentence(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("."), cut.lastIndexOf("\n"));
	return lastStop > max / 2 ? cut.slice(0, lastStop + 1) : cut;
}
