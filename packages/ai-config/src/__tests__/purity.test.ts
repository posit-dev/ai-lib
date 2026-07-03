/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Purity / isolation guards for the `ai-config` entrypoints (Phase 9).
 *
 * The pure `.` and node-bound `./node` entries must bundle WITHOUT `vscode`, so
 * non-Positron consumers (standalone, Notebooks) never gain a hard vscode dep.
 * Only the `./positron` entry is vscode-bound (vscode stays external there).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const PKG_ROOT = resolve(SRC, "..");

async function externals(entryRelToSrc: string): Promise<string[]> {
	const result = await esbuild.build({
		entryPoints: [resolve(SRC, entryRelToSrc)],
		absWorkingDir: PKG_ROOT,
		bundle: true,
		metafile: true,
		write: false,
		platform: "node",
		format: "esm",
		logLevel: "silent",
		external: ["vscode"],
	});
	const external = new Set<string>();
	for (const output of Object.values(result.metafile.outputs)) {
		for (const imp of output.imports) {
			if (imp.external) external.add(imp.path);
		}
	}
	return [...external];
}

describe("ai-config purity — pure entries are vscode-free", () => {
	it("the `.` entry bundles without vscode", async () => {
		expect(await externals("index.ts")).not.toContain("vscode");
	});

	it("the `./node` entry bundles without vscode", async () => {
		expect(await externals("node/index.ts")).not.toContain("vscode");
	});
});

describe("ai-config purity — /positron is the sole vscode-bound entry", () => {
	it("the `./positron` entry keeps vscode external", async () => {
		expect(await externals("positron/index.ts")).toContain("vscode");
	});
});
