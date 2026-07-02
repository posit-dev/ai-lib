/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { rmSync } from "node:fs";
import { builtinModules } from "node:module";

import { build, type BuildOptions, context } from "esbuild";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
rmSync("tsconfig.tsbuildinfo", { force: true });

const entrypoints = [
	"src/index.ts",
	"src/local-providers.ts",
	"src/types.ts",
	"src/providers.ts",
	"src/positron/index.ts",
	"src/credential-shaping.ts",
];

// Kept out of the bundle and resolved from node_modules at runtime. The provider
// SDKs are regular dependencies (installed transitively with the package); vscode
// is a host-provided optional peer. Not inlined because several (e.g. @aws-sdk/*,
// google-auth-library) bundle poorly.
const externalDeps = [
	"@ai-sdk/amazon-bedrock",
	"@ai-sdk/anthropic",
	"@ai-sdk/deepseek",
	"@ai-sdk/google",
	"@ai-sdk/google-vertex",
	"@ai-sdk/openai",
	"@ai-sdk/openai-compatible",
	"@aws-sdk/client-bedrock",
	"@aws-sdk/credential-providers",
	"@github/copilot-sdk",
	"@openrouter/ai-sdk-provider",
	"ai",
	"ai-sdk-ollama",
	"google-auth-library",
	"vscode",
];

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

const buildOptions: BuildOptions = {
	entryPoints: entrypoints,
	bundle: true,
	format: "esm",
	outdir: "dist",
	external: [...externalDeps, ...nodeBuiltins],
	platform: "node",
	target: "es2022",
	sourcemap: true,
	splitting: true,
};

if (watch) {
	const ctx = await context(buildOptions);
	await ctx.watch();
	console.log("esbuild: watching for changes...");
} else {
	await build(buildOptions);
}
