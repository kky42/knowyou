import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Whole-pipeline mutex. launchd rounds and manual runs can overlap (a consolidation's
 * LLM call takes minutes), and two concurrent read-modify-write cycles on MEMORY.md +
 * the pool can permanently erase memories. The lock file records the owning pid; a
 * stale lock (pid no longer alive, e.g. after a crash) is stolen.
 */
export function acquireLock(home: string): (() => void) | undefined {
	const lockPath = join(home, ".lock");
	mkdirSync(home, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockPath, "wx"); // O_EXCL — fails if the lock exists
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => {
				try {
					unlinkSync(lockPath);
				} catch {
					/* already gone */
				}
			};
		} catch {
			// Lock exists — steal it only if the owning pid is dead.
			let ownerAlive = true;
			try {
				const pid = parseInt(readFileSync(lockPath, "utf8"), 10);
				if (Number.isFinite(pid)) {
					process.kill(pid, 0); // signal 0 = liveness probe; throws ESRCH when dead
					ownerAlive = true;
				}
			} catch (err) {
				ownerAlive = (err as NodeJS.ErrnoException).code !== "ESRCH";
			}
			if (ownerAlive) return undefined;
			try {
				unlinkSync(lockPath);
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}
