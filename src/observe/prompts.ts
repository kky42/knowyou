export type { MessageEvent } from "../scan/events.js";

export interface ObservationInput {
	harness: string;
	path: string;
	sequence: number;
	startOffset: number;
	endOffset: number;
	rawTokens: number;
	compactedTokens: number;
	text: string;
}

const PROMPT_TEMPLATE = `You distill one observation from a small neighborhood of compacted AI coding-agent session slices. Slices may continue the same session or come from nearby sessions. Keep facts attributable and resolve conflicts by the latest stated state.

These records are the session's memory: once the raw conversation is gone, only what you capture is remembered, and anything you distort is remembered wrong.

Output format — nothing else:
- First line: "SUMMARY: " followed by ONE sentence (max 100 chars) capturing the most important fact across these slices.
- Then a blank line, then the body: atomic, factual notes, at most {MAX_CHARS} characters.
- The no-content option is ONLY for slices that contain no facts, decisions, completions, questions, or preferences at all — pure routine tool chatter. When in doubt, capture. To use it, reply with "SUMMARY: no new information" and a body of exactly "-".

Content rules:
- Record outcomes, decisions, and open questions — not play-by-play. (BAD: "Read src/auth.ts" GOOD: "Located token validation in src/auth.ts:45")
- Split compound statements: one fact per line. (BAD: "User is switching to pnpm and wants tests updated" GOOD: two facts on separate lines)
- When the user states something, record it as an assertion, not a question.
- Frame state changes as supersession so the old state stays explicit.
- Mark completions explicitly: "completed:", "resolved:", "confirmed working".
- Use precise verbs and preserve exact paths, identifiers, and numbers when useful.
- When statements conflict, the latest reflects current state.
- Write in the conversation's language. Never include API keys, tokens, or credentials. Never speculate beyond the transcript.

Compacted transcript slices:
---
{SLICES}
---`;

export function buildObservationPrompt(slices: ObservationInput[], maxObservationChars: number): string {
	const text = slices
		.map(
			(slice) =>
				`## slice ${slice.sequence} · ${slice.harness} · ${slice.path} · bytes ${slice.startOffset}-${slice.endOffset} · raw ~${slice.rawTokens} tokens · compacted ~${slice.compactedTokens} tokens\n${slice.text}`,
		)
		.join("\n\n");
	return PROMPT_TEMPLATE.replace("{MAX_CHARS}", String(maxObservationChars)).replace("{SLICES}", text);
}

export interface ParsedObservation {
	summary: string;
	body: string;
}

/** Parse model output and enforce the observation body cap ourselves. */
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
