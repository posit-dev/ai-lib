/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Purity / isolation guards for the `ai-credentials` entrypoints (Phase 9).
 *
 * These bundle each entry from source with esbuild and inspect the resulting
 * import graph (metafile) so the package's boundary invariants can't silently
 * regress:
 *
 * - `/types` is browser-safe: no `vscode`, no `@ai-sdk`/`@aws-sdk`/`ai` SDKs,
 *   no Node builtins, no `@assistant/*`, no `ai-config`, and no sibling entry
 *   (`/store`, `/store-backend`, `/positron`, or the root resolver files).
 * - the root imports only `/types` + its own resolver files — never `/store`,
 *   `/store-backend`, or `/positron`, and stays free of Node builtins/SDKs.
 * - `/store` is a generic leaf: no sibling `ai-credentials` entry, no SDK,
 *   no `@assistant/*`. (Node builtins + chokidar/proper-lockfile are allowed.)
 * - `/store-backend` bundles with NO `@assistant/*` import — the Notebooks
 *   independence guarantee — and no vscode/SDK, while legitimately pulling in
 *   `/types` + `/store`.
 * - `/positron` is the sole vscode-bound entry (vscode stays external).
 */

import { builtinModules, isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const PKG_ROOT = resolve(SRC, "..");

interface Graph {
	/** Every bundled input path (relative to the package root). */
	inputs: string[];
	/** Every module marked external by esbuild (SDKs, vscode, Node builtins). */
	external: string[];
}

/** Bundle an entry from source and collect its transitive import graph. */
async function bundleGraph(entryRelToSrc: string): Promise<Graph> {
	const result = await esbuild.build({
		entryPoints: [resolve(SRC, entryRelToSrc)],
		absWorkingDir: PKG_ROOT,
		bundle: true,
		metafile: true,
		write: false,
		platform: "node",
		format: "esm",
		logLevel: "silent",
		// vscode is ambient-typed only (no runtime module to resolve); mark it
		// external so a stray import surfaces as an external instead of a build
		// failure. Everything else is left resolvable so it shows up as an input.
		external: ["vscode"],
	});

	const inputs = Object.keys(result.metafile.inputs);
	const external = new Set<string>();
	for (const output of Object.values(result.metafile.outputs)) {
		for (const imp of output.imports) {
			if (imp.external) external.add(imp.path);
		}
	}
	return { inputs, external: [...external] };
}

const hasInput = (g: Graph, substr: string): boolean => g.inputs.some((i) => i.includes(substr));
const builtinExternals = (g: Graph): string[] =>
	g.external.filter((p) => isBuiltin(p) || builtinModules.includes(p.replace(/^node:/, "")));

/** SDK / heavy-runtime input markers that must never reach a pure entry. */
const SDK_INPUTS = [
	"node_modules/@ai-sdk",
	"node_modules/@aws-sdk",
	"node_modules/@github/copilot",
	"node_modules/ai/",
	"node_modules/google-auth",
] as const;

describe("ai-credentials purity — /types is browser-safe", () => {
	let g: Graph;
	beforeAll(async () => {
		g = await bundleGraph("types/index.ts");
	});

	it("pulls in no Node builtins", () => {
		expect(builtinExternals(g)).toEqual([]);
	});

	it("does not import vscode", () => {
		expect(g.external).not.toContain("vscode");
	});

	it("does not import any AI/AWS SDK", () => {
		for (const bad of SDK_INPUTS) {
			expect(hasInput(g, bad), `unexpected SDK input: ${bad}`).toBe(false);
		}
	});

	it("does not import @assistant/* or ai-config", () => {
		expect(hasInput(g, "@assistant")).toBe(false);
		expect(g.external.some((e) => e.startsWith("@assistant"))).toBe(false);
		expect(hasInput(g, "ai-config")).toBe(false);
	});

	it("does not import any sibling entry (store / store-backend / positron / root resolver)", () => {
		for (const sib of [
			"/store/",
			"/store-backend/",
			"/positron/",
			"/createCredentialProvider",
			"/device-auth",
			"/Backend",
			"/CredentialProvider",
		]) {
			expect(hasInput(g, sib), `unexpected sibling import: ${sib}`).toBe(false);
		}
	});

	it("exposes storageKeyFor from the pure entry", async () => {
		const mod = await import("../types");
		expect(typeof mod.storageKeyFor).toBe("function");
		expect(mod.storageKeyFor("anthropic", "apikey")).toBe("auth:anthropic:apikey");
	});
});

describe("ai-credentials purity — root never imports /store", () => {
	let g: Graph;
	beforeAll(async () => {
		g = await bundleGraph("index.ts");
	});

	it("does not import the generic /store, /store-backend, or /positron", () => {
		for (const sib of ["/store/", "/store-backend/", "/positron/"]) {
			expect(hasInput(g, sib), `root must not import ${sib}`).toBe(false);
		}
	});

	it("stays free of Node builtins, vscode, and SDKs (pure fetch + timers)", () => {
		expect(builtinExternals(g)).toEqual([]);
		expect(g.external).not.toContain("vscode");
		for (const bad of SDK_INPUTS) {
			expect(hasInput(g, bad)).toBe(false);
		}
	});

	it("does not import @assistant/* or ai-config", () => {
		expect(hasInput(g, "@assistant")).toBe(false);
		expect(hasInput(g, "ai-config")).toBe(false);
	});
});

describe("ai-credentials purity — /store is a generic leaf", () => {
	let g: Graph;
	beforeAll(async () => {
		g = await bundleGraph("store/index.ts");
	});

	it("imports no sibling ai-credentials entry", () => {
		for (const sib of [
			"/types/",
			"/store-backend/",
			"/positron/",
			"/createCredentialProvider",
			"/Backend",
			"/CredentialProvider",
			"/device-auth",
		]) {
			expect(hasInput(g, sib), `/store must not import ${sib}`).toBe(false);
		}
	});

	it("imports no SDK, @assistant/*, ai-config, or vscode", () => {
		expect(g.external).not.toContain("vscode");
		expect(hasInput(g, "@assistant")).toBe(false);
		expect(hasInput(g, "ai-config")).toBe(false);
		for (const bad of SDK_INPUTS) {
			expect(hasInput(g, bad)).toBe(false);
		}
	});
});

describe("ai-credentials purity — /store-backend is @assistant-free (Notebooks independence)", () => {
	let g: Graph;
	beforeAll(async () => {
		g = await bundleGraph("store-backend/index.ts");
	});

	it("bundles with NO @assistant/* import", () => {
		expect(hasInput(g, "@assistant")).toBe(false);
		expect(g.external.some((e) => e.startsWith("@assistant"))).toBe(false);
	});

	it("imports no vscode, SDK, or ai-config", () => {
		expect(g.external).not.toContain("vscode");
		expect(hasInput(g, "ai-config")).toBe(false);
		for (const bad of SDK_INPUTS) {
			expect(hasInput(g, bad)).toBe(false);
		}
	});

	it("does not reach the vscode-bound /positron entry", () => {
		expect(hasInput(g, "/positron/")).toBe(false);
	});

	it("runtime-imports /types (storageKeyFor, env resolver, Zod schema)", () => {
		expect(hasInput(g, "/types/")).toBe(true);
	});

	it("references /store as a type only — the concrete store is injected", () => {
		// StoreBackend takes a SingleFileStore instance via `createStoreBackend`,
		// so `../store` is a type-only import and is erased from the runtime graph.
		// This keeps the backend's fs surface entirely caller-provided.
		expect(hasInput(g, "/store/")).toBe(false);
	});
});

describe("ai-credentials purity — /positron is the sole vscode-bound entry", () => {
	it("keeps vscode external (never bundled)", async () => {
		const g = await bundleGraph("positron/index.ts");
		expect(g.external).toContain("vscode");
		expect(hasInput(g, "@assistant")).toBe(false);
	});
});
