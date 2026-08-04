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
	// src/dashboard/handler.ts imports page.html as a wrangler Text module. Vite
	// otherwise tries to parse it as a module and fails, which put every route on
	// that handler — including the dashboard's security headers — out of reach of
	// the suite. Treating .html as an asset makes it a string here too. v1.21.3
	assetsInclude: ["**/*.html"],
	test: {
		environment: "node",
		globals: false,
		include: ["test/**/*.test.ts"],
		reporters: ["default"],
	},
});
