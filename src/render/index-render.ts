import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * INDEX.md is a pure projection of observations/ (the om principle: never hand-maintain
 * an index that structure can render). One line per observation — the summary line from
 * the file body — sorted oldest first. Journals are deliberately not rendered here.
 */
export function renderIndex(home: string, now = new Date()): { count: number; file: string } {
	const obsDir = join(home, "observations");
	mkdirSync(obsDir, { recursive: true });
	const files = readdirSync(obsDir)
		.filter((name) => name.endsWith(".md"))
		.sort();

	const lines: string[] = ["# Observations", ""];
	for (const name of files) {
		const file = join(obsDir, name);
		const summary = summaryOf(file);
		if (!summary) continue;
		lines.push(`- [${slugTimestamp(name)}] ${summary} (observations/${name})`);
	}
	lines.push("");

	const indexFile = join(home, "INDEX.md");
	writeFileSync(indexFile, lines.join("\n"));
	return { count: files.length, file: indexFile };
}

/** "2026-07-14-10-30-00-2.md" → "2026-07-14 10:30:00" (suffix -N from uniqueness ignored). */
function slugTimestamp(name: string): string {
	const parts = name.replace(".md", "").split("-");
	if (parts.length < 6) return name;
	const [y, mo, d, h, mi, s] = parts;
	return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** The body's first non-empty line after front-matter is the summary. */
function summaryOf(file: string): string {
	if (!existsSync(file)) return "";
	const raw = readFileSync(file, "utf8");
	const body = raw.startsWith("---") ? raw.slice(raw.indexOf("---", 3) + 3) : raw;
	for (const line of body.split("\n")) {
		if (line.trim()) return line.trim().slice(0, 120);
	}
	return "";
}
