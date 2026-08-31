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
		let text = event.text.length > cap ? event.text.slice(0, cap) + " …[truncated]" : event.text;
		// Tool output can carry binary bytes; NUL/control chars crash spawn argv limits.
		text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
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

const PROMPT_TEMPLATE = `You distill an observation from a slice of an AI coding-agent session transcript. The slice may be a continuation of earlier context you cannot see.

These records are the session's memory: once the raw conversation is gone, only what you capture is remembered, and anything you distort is remembered wrong.

Output format — nothing else:
- First line: "SUMMARY: " followed by ONE sentence (max 100 chars) capturing the most important fact of the slice.
- Then a blank line, then the body: atomic, factual notes, at most {MAX_CHARS} characters.
- The no-content option is ONLY for slices that contain no facts, decisions, completions, questions, or preferences at all — pure routine tool chatter. When in doubt, capture. To use it, reply with "SUMMARY: no new information" and a body of exactly "-".

Content rules:
- Record outcomes, decisions, and open questions — not play-by-play. (BAD: "Read src/auth.ts" GOOD: "Located token validation in src/auth.ts:45")
- Split compound statements: one fact per line. (BAD: "User is switching to pnpm and wants tests updated" GOOD: two lines, one per fact)
- When the user states something, record it as an assertion, not a question. (BAD: "User wondered if they use Postgres" GOOD: "User stated they use Postgres")
- Frame state changes as supersession so the old state stays explicit. (BAD: "User prefers React Query now" GOOD: "User will use React Query (switching from SWR)")
- Mark completions explicitly: "completed:", "resolved:", "confirmed working". (BAD: "Wrote the login handler" GOOD: "completed: login handler at src/auth/login.ts; tests pass")
- Use precise verbs. (BAD: "got the library" GOOD: "installed zod via pnpm")
- When statements conflict, the latest reflects current state.
- Write in the conversation's language. Never include API keys, tokens, or credentials. Never speculate beyond the transcript.

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
