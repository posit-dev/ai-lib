#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Internal-consistency check for this repository's package-lock.json.
 *
 * The AI SDK packages `ai`, `@ai-sdk/provider`, and `@ai-sdk/provider-utils`
 * declare types branded with a `unique symbol` (e.g. Schema's
 * `schemaSymbol`), so two physical copies — even of compatible versions —
 * produce incompatible types and the provider bridge fails to compile. The
 * AI SDK provider packages pin these exactly, so updating one family member
 * without the others re-splits them into nested copies (e.g.
 * node_modules/ai/node_modules/@ai-sdk/provider-utils).
 *
 * This checks only this repository's own lockfile; it knows nothing about
 * consumers. Fix: update the whole AI SDK family together so npm dedupes to
 * a single copy.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const AI_SDK_BRAND_PACKAGES = ["ai", "@ai-sdk/provider", "@ai-sdk/provider-utils"];

const lockfile = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

const splits = [];
for (const pkg of AI_SDK_BRAND_PACKAGES) {
	const suffix = `node_modules/${pkg}`;
	const installs = Object.entries(lockfile.packages)
		.filter(([installPath]) => installPath.endsWith(suffix))
		.map(([installPath, entry]) => ({ path: installPath, version: entry.version ?? "unknown" }));
	if (installs.length > 1) {
		splits.push({ pkg, installs });
	}
}

if (splits.length === 0) {
	console.log("✓ AI SDK brand packages resolve to a single copy");
	process.exit(0);
}

console.error("✗ Multiple copies of nominally-branded AI SDK packages in package-lock.json:\n");
for (const { pkg, installs } of splits) {
	console.error(`  ${pkg}:`);
	for (const { path: p, version } of installs) {
		console.error(`    - ${p} (${version})`);
	}
}
console.error(
	"\nTwo physical copies of these packages produce incompatible types (the Schema" +
		"\nbrand is a unique symbol), so the provider bridge fails to compile." +
		"\nFix: update the AI SDK family together so npm dedupes to a single copy:" +
		"\n  npm update ai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/google-vertex \\" +
		"\n    @ai-sdk/openai @ai-sdk/openai-compatible @ai-sdk/amazon-bedrock \\" +
		"\n    @ai-sdk/deepseek @openrouter/ai-sdk-provider",
);
process.exit(1);
