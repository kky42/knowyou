import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Crash-safe replacement for writeFileSync on files whose loss is unrecoverable
 * (MEMORY.md: its source observations are already deleted; .state.json: watermark loss
 * would cause re-scans). writeFileSync truncates in place — a crash mid-write destroys
 * the previous content. Temp file + rename is atomic on the same filesystem.
 */
export function atomicWriteFileSync(file: string, data: string): void {
	const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}
