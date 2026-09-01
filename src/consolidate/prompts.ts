import type { KnowyouConfig } from "../config.js";

export interface ConsolidationInput {
	currentMemory: string;
	batch: Array<{ file: string; created: string; body: string }>;
	config: KnowyouConfig;
}

/**
 * Budget-aware consolidation prompt. The model sees exactly how much room is left
 * (chars, percent, headroom) and decides what to fold and what to evict; the quota is
 * advisory — overshoot is written as-is and self-corrects on the next round.
 *
 * Content rules are borrowed from observational-memory's consolidator prompt (current-state
 * prose, supersession, preserve distinguishing detail, conservative topic routing).
 */
export function buildConsolidationPrompt(input: ConsolidationInput): string {
	const { currentMemory, batch, config } = input;
	const max = config.consolidate.maxMemoryChars;
	const current = currentMemory.length;
	const percent = Math.min(100, Math.round((current / max) * 100));
	const headroom = Math.max(0, max - current);
	const batchChars = batch.reduce((total, b) => total + b.body.length, 0);

	const batchText = batch
		.map((b) => `### ${b.created}\n${b.body}`)
		.join("\n\n");

	const memorySection = currentMemory.trim()
		? currentMemory
		: "(MEMORY.md is currently empty — this is the first consolidation. Create sensible topic sections.)";

	return `You are the consolidation agent for knowyou, a persistent memory layer.

Your job: fold all pending observations (each about to be deleted from the
observation pool) into MEMORY.md — the agent's long-term consolidated memory. These
observations are about to be deleted, so anything worth keeping that you fail to record
here is forgotten forever. Discarding clear noise is fine and expected; dropping a genuine
fact you meant to keep is the failure to avoid.

## Budget (advisory, but treat as the target)

- Current MEMORY.md: ${current} / ${max} chars (${percent}% full)
- Remaining headroom: ${headroom} chars
- Incoming observations: ${batch.length}, ~${batchChars} chars

Keep the final MEMORY.md within ${max} chars. If folding everything would exceed the
budget, condense the OLDEST sections and move their content into the JOURNAL section
(concise wording) — recent content stays detailed, the distant past gets compressed.
If you end up over budget anyway, that is acceptable: it will be visible on the next
consolidation and you (or a later run) will shrink it then. Never drop content silently
just to fit; evict it through the JOURNAL section instead.

## Current MEMORY.md

---
${memorySection}
---

## Incoming observations (oldest first)

${batch.length > 0 ? batchText : "(None this round.)"}

${batch.length === 0 ? "IMPORTANT: there are no incoming observations. Your ONLY task is to shrink MEMORY.md to fit the budget: condense the oldest sections and move their content into the JOURNAL section." : ""}

## How to fold

- Merge and deduplicate: observations often restate or extend what MEMORY.md already
  holds. The newest statement reflects current state — rewrite the affected section to
  the new truth and delete the obsolete statement. No "was X, now Y" tombstones.
- Preserve distinguishing detail: file paths, identifiers, package/function names, error
  codes, exact numbers, the user's own terminology (quote unusual terms verbatim).
- Preserve the assertion vs question distinction: user assertions are authoritative.
- Organize by topic sections (free-form "## topic" headings; start conservative — prefer
  fewer, larger sections; split only when a section clearly covers unrelated subjects).
- Keep prose tight and skimmable: short bullets are fine; this is reference material.
- Keep the existing section structure where it still works; do not reshuffle for its own
  sake.

## JOURNAL section

The journal is the archive for content that LEFT MEMORY.md in this consolidation: sections
compressed to fit the budget, or material that aged out. Write it concise — enough to
re-find the idea later, not the full text. If nothing was evicted, output "-".

## Output format — exactly this, nothing else

===MEMORY===
<the complete new MEMORY.md>
===JOURNAL===
<concise evicted/compressed content, or "-">`;
}
