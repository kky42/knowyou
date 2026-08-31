import { openSync, readSync, closeSync, fstatSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MessageEvent } from "../agents/observe-prompt.js";
import { redactSecrets } from "./redact.js";

/**
 * Pi session store adapter — structure mirrors backpass's discovery/adapters/pi.js
 * (enumerate / classify / read) plus the byte-offset increment reading backpass lacks
 * (backpass re-reads whole files on change; pi sessions are append-only JSONL, so a
 * watermark offset is safe and lets us distill only new message text).
 *
 * Counting scope: only `message` entries with role user/assistant/toolResult count toward
 * the increment threshold; thinking blocks, custom extension entries, model_change,
 * compaction markers etc. are excluded.
 */

export interface SessionFileInfo {
	path: string;
	mtimeMs: number;
	bytes: number;
}

export interface IncrementResult {
	/** Message text events in the new region (already secret-redacted). */
	events: MessageEvent[];
	/** User-role message turns in the new region. */
	userTurns: number;
	/** Redacted message-text chars in the new region — the threshold metric. */
	newChars: number;
	/** Byte offset after the last complete newline in the new region. */
	newOffset: number;
}

export function storeRoots(): string[] {
	// Test/isolation override: scan ONLY these roots (colon-separated). Without it, an
	// E2E run against a temp store would silently fall through to the real session store.
	const override = process.env["KNOWYOU_STORE_ROOTS"];
	if (override) return override.split(":").filter((p) => existsSync(p));
	const roots = [join(homedir(), ".pi", "agent", "sessions")];
	const agentDir = process.env["PI_CODING_AGENT_DIR"];
	if (agentDir) roots.push(join(agentDir, "sessions"));
	return roots.filter((root) => existsSync(root));
}

export function enumerateSessions(): SessionFileInfo[] {
	const out: SessionFileInfo[] = [];
	for (const root of storeRoots()) {
		for (const dir of listDirs(root)) {
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".jsonl")) continue;
				const file = join(dir, name);
				const stat = statSync(file);
				if (!stat.isFile()) continue;
				out.push({ path: file, mtimeMs: stat.mtimeMs, bytes: stat.size });
			}
		}
	}
	return out;
}

function listDirs(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((name) => join(root, name))
		.filter((p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		});
}

/** Cheap validation: line 1 must be the session header ({type:"session", cwd, id}). */
export function looksLikeSession(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(Math.min(4096, fstatSync(fd).size));
			readSync(fd, buffer, 0, buffer.length, 0);
			const parsed = JSON.parse(buffer.toString("utf8").split("\n")[0] ?? "");
			return parsed?.type === "session" && typeof parsed?.cwd === "string";
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "string"
				? block
				: block?.type === "text" && typeof block.text === "string"
					? block.text
					: "",
		)
		.filter(Boolean)
		.join("\n");
}

function countUserTurnsInRegion(region: string): number {
	let count = 0;
	for (const line of region.split("\n")) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "message" && entry.message?.role === "user") count += 1;
		} catch {
			// Torn or foreign line — not a user turn.
		}
	}
	return count;
}

/**
 * Read the unprocessed region `[offset, EOF)` of an append-only JSONL session,
 * aligned back to the last complete newline. Returns parsed message events plus the
 * byte offset to persist only after the increment has been absorbed.
 */
export function readIncrement(path: string, offset: number, redact: boolean): IncrementResult {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) {
			return { events: [], userTurns: 0, newChars: 0, newOffset: Math.min(offset, size) };
		}
		const length = size - offset;
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, offset);
		const lastNewline = buffer.lastIndexOf(0x0a);
		if (lastNewline === -1) {
			// No complete line yet — wait for more data.
			return { events: [], userTurns: 0, newChars: 0, newOffset: offset };
		}
		const region = buffer.subarray(0, lastNewline + 1).toString("utf8");
		const newOffset = offset + lastNewline + 1;

		const events: IncrementResult["events"] = [];
		let newChars = 0;
		for (const line of region.split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message" || !entry.message) continue;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
			const text = redact ? redactSecrets(textOf(entry.message.content)) : textOf(entry.message.content);
			if (!text.trim()) continue;
			newChars += text.length;
			if (role === "user") events.push({ role: "user", text });
			else if (role === "assistant") events.push({ role: "assistant", text });
			else events.push({ role: "tool", text });
		}
		return { events, userTurns: countUserTurnsInRegion(region), newChars, newOffset };
	} finally {
		closeSync(fd);
	}
}
