import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfig } from "../src/config.js";
import { buildObservationPrompt } from "../src/observe/prompts.js";
import { MAX_COMPACTED_TOKENS, preprocessEvents } from "../src/observe/preprocess.js";
import { getAdapter } from "../src/scan/adapters.js";
import { splitScanSlices } from "../src/scan/scan.js";
import { estimateTokens } from "../src/tokens.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const pi = getAdapter("pi")!;
const resultsRoot = join(process.cwd(), "e2e-results");

interface RealSession {
	path: string;
	tokens: number;
	userTurns: number;
}

let realCorpus: { long: RealSession[]; superLong: RealSession; short: RealSession[] } | undefined;

function jsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function message(role: "user" | "assistant", text: string): string {
	return jsonLine({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

function selectRealCorpus(): { long: RealSession[]; superLong: RealSession; short: RealSession[] } {
	if (realCorpus) return realCorpus;
	const candidates = pi.enumerate(0).filter((candidate) => candidate.mtimeMs < Date.now() - 60_000);
	const inspect = (path: string): RealSession | undefined => {
		if (pi.classify(path) !== "interactive") return undefined;
		const increment = pi.readIncrement(path, 0, true);
		return { path, tokens: increment.newTokens, userTurns: increment.userTurns };
	};

	const long: RealSession[] = [];
	let superLong: RealSession | undefined;
	for (const candidate of [...candidates].sort((a, b) => b.bytes - a.bytes)) {
		const session = inspect(candidate.path);
		if (!session || session.userTurns < 2) continue;
		if (!superLong && session.tokens >= 500_000) superLong = session;
		else if (session.tokens >= 100_000 && session.tokens < 500_000 && long.length < 3) long.push(session);
		if (superLong && long.length === 3) break;
	}

	const short: RealSession[] = [];
	for (const candidate of [...candidates].sort((a, b) => a.bytes - b.bytes)) {
		const session = inspect(candidate.path);
		if (!session || session.userTurns < 2 || session.tokens >= 20_000) continue;
		short.push(session);
		if (short.length === 3) break;
	}

	if (!superLong || long.length < 3 || short.length < 3) {
		throw new Error(
			`Real Pi corpus requirement not met: long=${long.length}/3, superLong=${superLong ? 1 : 0}/1, short=${short.length}/3`,
		);
	}
	realCorpus = { long, superLong, short };
	return realCorpus;
}

function createLinkedStore(sessions: RealSession[]): { stores: string; root: string; linked: Map<string, RealSession> } {
	const stores = mkdtempSync(join(tmpdir(), "knowyou-e2e-real-store-"));
	temporaryPaths.push(stores);
	const root = join(stores, "sessions");
	mkdirSync(root, { recursive: true });
	const linked = new Map<string, RealSession>();
	for (const [index, session] of sessions.entries()) {
		const link = join(root, `real-${index}.jsonl`);
		symlinkSync(session.path, link);
		linked.set(link, session);
	}
	return { stores, root, linked };
}

function writeRealConfig(home: string, consolidateAt: number): void {
	writeFileSync(
		join(home, "config.yaml"),
		`scan:\n  windowDays: 3650\n  minNewTokens: 20000\n  maxNewTokens: 200000\n  minUserTurns: 2\n  harnesses: [pi]\nobserve:\n  maxObservationChars: 1000\n  maxSlicesPerRun: 50\nagent:\n  model: dgx-spark/qwen3.8-27b\n  thinking: medium\nconsolidate:\n  triggerObservations: ${consolidateAt}\n  maxMemoryChars: 20000\n`,
	);
}

function observationSequence(name: string): number {
	const parts = name.replace(/\.md$/, "").split("-");
	return parts.length > 6 ? Number(parts.at(-1)) : 1;
}

async function runCli(home: string, storeRoot: string) {
	return execFileAsync(process.execPath, [join(process.cwd(), "dist", "cli.js"), "run"], {
		env: { ...process.env, KNOWYOU_HOME: home, KNOWYOU_STORE_ROOTS: storeRoot },
		timeout: 850_000,
		maxBuffer: 4 * 1024 * 1024,
	});
}

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("real Pi pipeline", () => {
	it("scans a Pi session, observes it with qwen3.8-27b, and consolidates durable memory", async () => {
		const home = mkdtempSync(join(tmpdir(), "knowyou-e2e-home-"));
		const stores = mkdtempSync(join(tmpdir(), "knowyou-e2e-store-"));
		temporaryPaths.push(home, stores);
		const sessions = join(stores, "sessions", "project");
		mkdirSync(sessions, { recursive: true });

		const marker = `KNOWYOU_E2E_DECISION_${Date.now()}`;
		writeFileSync(
			join(sessions, "session.jsonl"),
			jsonLine({ type: "session", version: 3, id: "knowyou-e2e", timestamp: new Date().toISOString(), cwd: process.cwd() }) +
				message("user", `Remember this durable decision: ${marker} means production deploys require staging approval.`) +
				message("assistant", `Confirmed: ${marker} requires staging approval before production.`) +
				message("user", "This is the second user turn; preserve the exact decision marker in memory."),
		);
		writeFileSync(
			join(home, "config.yaml"),
			`scan:\n  minNewTokens: 10\n  maxNewTokens: 200000\n  minUserTurns: 2\n  harnesses: [pi]\nobserve:\n  maxObservationChars: 1000\n  maxSlicesPerRun: 10\nagent:\n  model: dgx-spark/qwen3.8-27b\n  thinking: medium\nconsolidate:\n  triggerObservations: 1\n  maxMemoryChars: 5000\n`,
		);

		const cli = join(process.cwd(), "dist", "cli.js");
		const result = await execFileAsync(process.execPath, [cli, "run"], {
			env: { ...process.env, KNOWYOU_HOME: home, KNOWYOU_STORE_ROOTS: join(stores, "sessions") },
			timeout: 400_000,
			maxBuffer: 1024 * 1024,
		});

		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("observation:");
		expect(result.stdout).toContain("consolidate: folded 1 observation(s)");
		expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toContain(marker);
		expect(readFileSync(join(home, ".state.json"), "utf8")).toContain('"chunks": 1');
	});

	it("compacts and observes three long and one super-long real session", async () => {
		const corpus = selectRealCorpus();
		const selected = [...corpus.long, corpus.superLong];
		const resultDir = join(resultsRoot, "real-long-sessions");
		rmSync(resultDir, { recursive: true, force: true });
		mkdirSync(join(resultDir, "compacted"), { recursive: true });
		expect(corpus.long).toHaveLength(3);
		expect(corpus.long.every((session) => session.tokens >= 100_000 && session.tokens < 500_000)).toBe(true);
		expect(corpus.superLong.tokens).toBeGreaterThanOrEqual(500_000);

		const expectedChunks = new Map<RealSession, number>();
		const receipt: Array<{
			source: string;
			rawTokens: number;
			userTurns: number;
			slices: Array<{ rawTokens: number; compactedTokens: number; elided: boolean }>;
		}> = [];
		let sawElision = false;
		for (const [sessionIndex, session] of selected.entries()) {
			const increment = pi.readIncrement(session.path, 0, true);
			const slices = splitScanSlices(increment.events, 0, increment.newOffset, 200_000, 20_000);
			expect(slices.length).toBeGreaterThan(0);
			expectedChunks.set(session, slices.length);
			const sliceReceipts: Array<{ rawTokens: number; compactedTokens: number; elided: boolean }> = [];
			for (const slice of slices) {
				const compacted = preprocessEvents(slice.events);
				sawElision ||= compacted.elided;
				sliceReceipts.push({ rawTokens: slice.rawTokens, compactedTokens: compacted.estimatedTokens, elided: compacted.elided });
				writeFileSync(
					join(resultDir, "compacted", `session-${sessionIndex + 1}-slice-${slice.sequence + 1}.md`),
					`---\nsource: ${JSON.stringify(session.path)}\nrawTokens: ${slice.rawTokens}\ncompactedTokens: ${compacted.estimatedTokens}\nelided: ${compacted.elided}\n---\n${compacted.text}\n`,
				);
				expect(compacted.estimatedTokens).toBeLessThanOrEqual(MAX_COMPACTED_TOKENS);
				const prompt = buildObservationPrompt(
					{
						harness: "pi",
						path: session.path,
						sequence: slice.sequence,
						startOffset: slice.startOffset,
						endOffset: slice.endOffset,
						rawTokens: slice.rawTokens,
						compactedTokens: compacted.estimatedTokens,
						text: compacted.text,
					},
					1000,
				);
				expect(estimateTokens(prompt)).toBeLessThan(12_000);
			}
			receipt.push({ source: session.path, rawTokens: session.tokens, userTurns: session.userTurns, slices: sliceReceipts });
		}
		expect(sawElision).toBe(true);
		writeFileSync(join(resultDir, "corpus.json"), `${JSON.stringify(receipt, null, 2)}\n`);

		const home = join(resultDir, "knowyou-home");
		mkdirSync(home, { recursive: true });
		const store = createLinkedStore(selected);
		writeRealConfig(home, 999);
		const observationRun = await runCli(home, store.root);
		writeFileSync(join(resultDir, "observe.stdout.log"), observationRun.stdout);
		writeFileSync(join(resultDir, "observe.stderr.log"), observationRun.stderr);
		expect(observationRun.stderr).toBe("");
		expect(observationRun.stdout).toContain(`scan: 4 candidate session(s)`);
		expect(observationRun.stdout).toContain("observation:");
		cpSync(join(home, "observations"), join(resultDir, "observations-before-consolidation"), { recursive: true });

		writeRealConfig(home, 1);
		const consolidationRun = await runCli(home, store.root);
		writeFileSync(join(resultDir, "consolidate.stdout.log"), consolidationRun.stdout);
		writeFileSync(join(resultDir, "consolidate.stderr.log"), consolidationRun.stderr);

		expect(consolidationRun.stderr).toBe("");
		expect(consolidationRun.stdout).toMatch(/consolidate: folded [1-9]\d* observation\(s\)/);
		expect(readFileSync(join(home, "MEMORY.md"), "utf8").trim().length).toBeGreaterThan(0);
		const state = JSON.parse(readFileSync(join(home, ".state.json"), "utf8")) as {
			sessions: Record<string, { chunks: number }>;
		};
		for (const [link, session] of store.linked) {
			expect(state.sessions[link]?.chunks).toBe(expectedChunks.get(session));
		}

		const observationDir = join(resultDir, "observations-before-consolidation");
		const observationFiles = readdirSync(observationDir)
			.filter((name) => name.endsWith(".md"))
			.sort((a, b) => observationSequence(a) - observationSequence(b));
		const pieces = receipt.flatMap((session, sessionIndex) =>
			session.slices.map((slice, sliceIndex) => ({ sessionIndex, sliceIndex, ...slice })),
		);
		expect(observationFiles).toHaveLength(pieces.length);
		const pieceRows = pieces.map((piece, index) => {
			const raw = readFileSync(join(observationDir, observationFiles[index]!), "utf8");
			const content = raw.slice(raw.indexOf("---", 3) + 3).trim();
			const [summary = "", ...bodyLines] = content.split("\n");
			return {
				...piece,
				observationFile: observationFiles[index]!,
				summaryChars: summary.length,
				observationChars: bodyLines.join("\n").trim().length,
			};
		});
		const memory = readFileSync(join(home, "MEMORY.md"), "utf8").trim();
		const journalDir = join(home, "journals");
		const journalFiles = existsSync(journalDir) ? readdirSync(journalDir).filter((name) => name.endsWith(".md")) : [];
		const report = [
			"# Real-session E2E report",
			"",
			"Token lengths use the product estimator: UTF-8 bytes / 4.",
			"",
			"## Sessions",
			"",
			"| Session | Raw file | Normalized tokens | User turns | Pieces |",
			"|---:|---:|---:|---:|---:|",
			...selected.map(
				(session, index) =>
					`| ${index + 1} | ${(statSync(session.path).size / 1024 / 1024).toFixed(2)} MiB | ${session.tokens.toLocaleString("en-US")} | ${session.userTurns} | ${receipt[index]!.slices.length} |`,
			),
			"",
			"## Pieces and observations",
			"",
			"| Session | Piece | Raw tokens | Compacted tokens | Elided | Summary chars | Observation chars | File |",
			"|---:|---:|---:|---:|:---:|---:|---:|---|",
			...pieceRows.map(
				(row) =>
					`| ${row.sessionIndex + 1} | ${row.sliceIndex + 1} | ${row.rawTokens.toLocaleString("en-US")} | ${row.compactedTokens.toLocaleString("en-US")} | ${row.elided ? "yes" : "no"} | ${row.summaryChars} | ${row.observationChars} | [observation](observations-before-consolidation/${row.observationFile}) |`,
			),
			"",
			"## Consolidation",
			"",
			`- Input observations: ${observationFiles.length}`,
			`- Final MEMORY.md: ${memory.length.toLocaleString("en-US")} chars, ~${estimateTokens(memory).toLocaleString("en-US")} tokens`,
			`- Journal files: ${journalFiles.length}`,
			`- Observation stderr: ${statSync(join(resultDir, "observe.stderr.log")).size} bytes`,
			`- Consolidation stderr: ${statSync(join(resultDir, "consolidate.stderr.log")).size} bytes`,
			"",
			"Review [MEMORY.md](knowyou-home/MEMORY.md), [compacted traces](compacted/), and [pre-consolidation observations](observations-before-consolidation/).",
			"",
		].join("\n");
		writeFileSync(join(resultDir, "REPORT.md"), report);
	});

	it("keeps several short real sessions pending without calling the observation agent", async () => {
		const corpus = selectRealCorpus();
		const resultDir = join(resultsRoot, "real-short-sessions");
		rmSync(resultDir, { recursive: true, force: true });
		mkdirSync(resultDir, { recursive: true });
		expect(corpus.short).toHaveLength(3);
		expect(corpus.short.every((session) => session.tokens < 20_000 && session.userTurns >= 2)).toBe(true);

		writeFileSync(join(resultDir, "corpus.json"), `${JSON.stringify(corpus.short, null, 2)}\n`);
		const home = join(resultDir, "knowyou-home");
		mkdirSync(home, { recursive: true });
		const store = createLinkedStore(corpus.short);
		writeRealConfig(home, 30);
		const result = await runCli(home, store.root);
		writeFileSync(join(resultDir, "run.stdout.log"), result.stdout);
		writeFileSync(join(resultDir, "run.stderr.log"), result.stderr);

		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("scan: 0 candidate session(s), 0 raw slice(s), 3 pending");
		expect(result.stdout).not.toContain("observation:");
		const state = JSON.parse(readFileSync(join(home, ".state.json"), "utf8")) as {
			sessions: Record<string, { pending: boolean; chunks: number }>;
		};
		for (const link of store.linked.keys()) {
			expect(state.sessions[link]).toMatchObject({ pending: true, chunks: 0 });
		}
	});
});
