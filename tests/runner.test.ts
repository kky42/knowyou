import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runAgentPrompt } from "../src/agents/runner.js";

function fakeChild() {
	return Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
	});
}

describe("pi runner", () => {
	beforeEach(() => spawnMock.mockReset());

	it("uses Pi's configured model and thinking defaults when omitted", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValueOnce(child);
		const result = runAgentPrompt({ prompt: "hello" });
		child.stdout.emit("data", "result");
		child.emit("close", 0, null);

		await expect(result).resolves.toBe("result");
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args).not.toContain("--provider");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--thinking");
		expect(args.slice(-2)).toEqual(["--", "hello"]);
	});

	it("passes explicit model and thinking overrides to Pi", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValueOnce(child);
		const result = runAgentPrompt({ prompt: "hello", model: "openai/gpt-5.6-luna", thinking: "high" });
		child.stdout.emit("data", "result");
		child.emit("close", 0, null);

		await expect(result).resolves.toBe("result");
		const args = spawnMock.mock.calls[0]?.[1] as string[];
		expect(args).toContain("--provider");
		expect(args).toContain("openai");
		expect(args).toContain("--model");
		expect(args).toContain("gpt-5.6-luna");
		expect(args).toContain("--thinking");
		expect(args).toContain("high");
	});
});
