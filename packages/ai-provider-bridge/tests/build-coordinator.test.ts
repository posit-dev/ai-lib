/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	acquireCoordinatorLock,
	GenerationBuildLoop,
	promoteGeneration,
	validateGeneration,
} from "../scripts/build-coordinator";

const temporaryDirectories: string[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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

describe("bridge coordinator locking", () => {
	it("does not take over a freshly created lock whose owner record is incomplete", async () => {
		const root = await temporaryDirectory("bridge-lock-incomplete-");
		const lock = path.join(root, "coordinator.lock");
		await mkdir(lock);
		await writeFile(path.join(lock, "owner.json"), "");

		await expect(acquireCoordinatorLock(lock)).rejects.toThrow(/initializ|active/i);
	});

	it("allows only one contender to replace a stale lock", async () => {
		const root = await temporaryDirectory("bridge-lock-race-");
		const lock = path.join(root, "coordinator.lock");
		await mkdir(lock);
		await writeFile(
			path.join(lock, "owner.json"),
			JSON.stringify({ pid: 2_147_483_647, token: "stale", startedAt: new Date(0).toISOString() }),
		);

		const contenders = await Promise.allSettled([
			acquireCoordinatorLock(lock),
			acquireCoordinatorLock(lock),
		]);
		const winners = contenders.filter(
			(result): result is PromiseFulfilledResult<() => Promise<void>> =>
				result.status === "fulfilled",
		);
		expect(winners).toHaveLength(1);
		await winners[0]?.value();
	});

	it("recovers an old malformed lock after the initialization grace period", async () => {
		const root = await temporaryDirectory("bridge-lock-malformed-stale-");
		const lock = path.join(root, "coordinator.lock");
		await mkdir(lock);
		await writeFile(path.join(lock, "owner.json"), "incomplete");
		const staleTime = new Date(Date.now() - 10_000);
		await utimes(lock, staleTime, staleTime);

		const release = await acquireCoordinatorLock(lock);
		await release();
	});

	it("migrates a stale lock file left by the previous coordinator", async () => {
		const root = await temporaryDirectory("bridge-lock-legacy-");
		const lock = path.join(root, "coordinator.lock");
		await writeFile(
			lock,
			JSON.stringify({ pid: 2_147_483_647, token: "legacy", startedAt: new Date(0).toISOString() }),
		);

		const release = await acquireCoordinatorLock(lock);
		await release();
	});
});

describe("bridge generation build loop", () => {
	it("reconciles an edit that arrives during the initial build", async () => {
		const initialBuild = deferred();
		const fingerprints = ["initial", "edited"];
		const buildNextGeneration = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(() => initialBuild.promise)
			.mockResolvedValue(undefined);
		const reportFailure = vi.fn();
		const loop = new GenerationBuildLoop(
			async () => fingerprints.shift() ?? "edited",
			buildNextGeneration,
			reportFailure,
		);

		const initializing = loop.initialize();
		await vi.waitFor(() => expect(buildNextGeneration).toHaveBeenCalledOnce());
		void loop.request();
		initialBuild.resolve();
		await initializing;

		expect(buildNextGeneration).toHaveBeenCalledTimes(2);
		expect(reportFailure).not.toHaveBeenCalled();
	});

	it("recovers after a fingerprint race without wedging the loop", async () => {
		const fingerprint = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("initial")
			.mockRejectedValueOnce(new Error("source disappeared"))
			.mockResolvedValueOnce("edited");
		const buildNextGeneration = vi.fn(async () => {});
		const reportFailure = vi.fn();
		const loop = new GenerationBuildLoop(fingerprint, buildNextGeneration, reportFailure);

		await loop.initialize();
		await loop.request();
		await loop.request();

		expect(reportFailure).toHaveBeenCalledWith(
			expect.objectContaining({ message: "source disappeared" }),
		);
		expect(buildNextGeneration).toHaveBeenCalledTimes(2);
	});
});
