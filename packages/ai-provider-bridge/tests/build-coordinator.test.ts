/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { promoteGeneration, validateGeneration } from "../scripts/build-coordinator";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("bridge generation validation", () => {
	it("accepts the complete generated package and keeps vscode declarations quarantined", async () => {
		const dist = path.resolve(import.meta.dirname, "../dist");
		await expect(validateGeneration(dist)).resolves.toContain("index.d.ts");
	});

	it("rejects a staged generation with a missing exported declaration", async () => {
		const stage = await temporaryDirectory("bridge-invalid-stage-");
		await cp(path.resolve(import.meta.dirname, "../dist"), stage, { recursive: true });
		await rm(path.join(stage, "index.d.ts"));
		await expect(validateGeneration(stage)).rejects.toThrow("Missing staged export target");
	});

	it("rejects a staged generation whose runtime entrypoint cannot be imported", async () => {
		const stage = await temporaryDirectory("bridge-invalid-runtime-");
		await cp(path.resolve(import.meta.dirname, "../dist"), stage, { recursive: true });
		await writeFile(path.join(stage, "index.js"), "this is not JavaScript");
		await expect(validateGeneration(stage)).rejects.toThrow(
			"Unable to import staged runtime entrypoint index.js",
		);
	});
});

describe("bridge generation promotion", () => {
	it("promotes a complete staged generation over existing live files", async () => {
		const root = await temporaryDirectory("bridge-promotion-success-");
		const stage = path.join(root, "stage");
		const live = path.join(root, "live");
		const state = path.join(root, "state");
		await Promise.all([
			(await import("node:fs/promises")).mkdir(stage, { recursive: true }),
			(await import("node:fs/promises")).mkdir(live, { recursive: true }),
		]);
		await Promise.all([
			writeFile(path.join(stage, "chunk.js"), "new chunk"),
			writeFile(path.join(stage, "index.js"), "new entrypoint"),
			writeFile(path.join(live, "chunk.js"), "old chunk"),
			writeFile(path.join(live, "index.js"), "old entrypoint"),
		]);

		await promoteGeneration(stage, ["index.js", "chunk.js"], ["index.js"], live, state);

		expect(await readFile(path.join(live, "chunk.js"), "utf8")).toBe("new chunk");
		expect(await readFile(path.join(live, "index.js"), "utf8")).toBe("new entrypoint");
	});

	it("promotes complete files and restores earlier replacements after a later failure", async () => {
		const root = await temporaryDirectory("bridge-promotion-");
		const stage = path.join(root, "stage");
		const live = path.join(root, "live");
		const state = path.join(root, "state");
		await Promise.all([
			(await import("node:fs/promises")).mkdir(stage, { recursive: true }),
			(await import("node:fs/promises")).mkdir(live, { recursive: true }),
		]);
		await writeFile(path.join(stage, "a.js"), "new");
		await writeFile(path.join(live, "a.js"), "old");

		await expect(promoteGeneration(stage, ["a.js", "missing.js"], [], live, state)).rejects.toThrow(
			"Bridge promotion failed",
		);
		expect(await readFile(path.join(live, "a.js"), "utf8")).toBe("old");
	});
});
