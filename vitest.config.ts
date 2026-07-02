import { defineConfig } from "vitest/config";

// Test config for the trello-mcp unit tests.
//
// Runs in a plain Node environment — none of the code under test needs the
// Cloudflare Workers runtime. Tests mock `globalThis.fetch` when they exercise
// client HTTP paths.
//
// No coverage tooling wired in yet — priority is a compact, meaningful test
// suite first; coverage-as-metric can layer on later if we ever want it.

export default defineConfig({
	test: {
		environment: "node",
		globals: false,
		include: ["test/**/*.test.ts"],
		reporters: ["default"],
	},
});
