import { spawn } from "node:child_process";

/**
 * Background LLM runner via the pi CLI. `--no-session` is essential: runner calls must not
 * create session files in the store we ourselves scan (self-exclusion at the source).
 * The remaining `-n*` flags strip the interactive harness — pure text-in/text-out.
 */
export async function runAgentPrompt(opts: {
	prompt: string;
	model: string; // "provider/model"
	thinking: string;
	timeoutMs?: number;
}): Promise<string> {
	const slash = opts.model.indexOf("/");
	const provider = slash > 0 ? opts.model.slice(0, slash) : undefined;
	const modelId = slash > 0 ? opts.model.slice(slash + 1) : opts.model;

	const args = [
		"-p",
		"--no-session",
		"-nc", // no AGENTS.md/context files — the runner sees only our prompt
		"-ne", // no extensions
		"-ns", // no skills
		"-np", // no prompt templates
		"-nt", // no tools
		"--offline",
		// Replace pi's coding-assistant persona: the runner is a text engine, our prompt
		// is the entire instruction set.
		"--system-prompt",
		"You are a text-processing engine. Follow the user's instructions exactly and output only what they specify.",
	];
	if (provider) args.push("--provider", provider);
	args.push("--model", modelId, "--thinking", opts.thinking, "--", opts.prompt);

	return new Promise<string>((resolve, reject) => {
		// pi -p reads stdin to EOF when stdin is not a TTY; a default open pipe would hang
		// the call. "ignore" gives the child a closed fd instead.
		const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 180_000);
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const why = signal ? `killed by ${signal} (timeout?)` : `exit code ${code}`;
			const detail = stderr.trim();
			reject(new Error(`pi runner failed (${why})${detail ? ` — stderr: ${detail.slice(0, 2000)}` : ""}`));
		});
	});
}
