import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// reference/ holds cloned upstream repos with their own test suites — not ours to run.
		exclude: ["**/node_modules/**", "**/reference/**", "**/dist/**"],
	},
});
