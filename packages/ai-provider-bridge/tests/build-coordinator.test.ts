/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	acquireCoordinatorRole,
	claimWriterLock,
	followGenerations,
	GenerationBuildLoop,
	GenerationObserver,
	promoteGeneration,
	publishGeneration,
	reusableGeneration,
	runCoordinator,
	validateGeneration,
	type Closeable,
	type CoordinatorPaths,
	type GenerationObserverAdapters,
	type GenerationRecord,
	type ObservedWatchOwner,
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

function coordinatorPaths(root: string): CoordinatorPaths {
	const state = path.join(root, ".bridge-watch");
	return {
		distDir: path.join(root, "dist"),
		stateDir: state,
		stagingRoot: path.join(state, "staging"),
		generationFile: path.join(state, "generation.json"),
		readyFile: path.join(state, "ready.json"),
		lockDirectory: path.join(state, "coordinator.lock"),
	};
}

async function writeLiveOwner(
	lock: string,
	mode: "watch" | "oneshot" | undefined,
	pid = 42,
): Promise<void> {
	await mkdir(path.dirname(lock), { recursive: true });
	await writeFile(
		lock,
		JSON.stringify({
			pid,
			token: `owner-${pid}`,
			startedAt: new Date(0).toISOString(),
			...(mode ? { mode } : {}),
		}),
	);
}

async function writeGeneration(
	paths: CoordinatorPaths,
	generation: number,
	token: string,
): Promise<GenerationRecord> {
	await Promise.all([
		mkdir(paths.distDir, { recursive: true }),
		mkdir(paths.stateDir, { recursive: true }),
	]);
	const content = `export const generation = ${generation};`;
	await writeFile(path.join(paths.distDir, "index.js"), content);
	const record: GenerationRecord = {
		generation,
		inputFingerprint: `fingerprint-${generation}`,
		manifest: ["index.js"],
		digests: { "index.js": createHash("sha256").update(content).digest("hex") },
		completedAt: new Date(generation * 1_000).toISOString(),
	};
	await Promise.all([
		writeFile(paths.generationFile, JSON.stringify(record)),
		writeFile(paths.readyFile, JSON.stringify({ token, generation })),
	]);
	return record;
}

async function writeObserverOwner(
	paths: CoordinatorPaths,
	owner: ObservedWatchOwner,
): Promise<void> {
	await mkdir(paths.stateDir, { recursive: true });
	await writeFile(paths.lockDirectory, JSON.stringify(owner));
}

function observationHarness() {
	let onChange: (() => void) | null = null;
	let onPoll: (() => void) | null = null;
	let watchClosed = false;
	let pollClosed = false;
	const adapters: GenerationObserverAdapters = {
		watchDirectory: (_directory, callback) => {
			onChange = callback;
			return { close: () => (watchClosed = true) };
		},
		schedulePoll: (callback) => {
			onPoll = callback;
			return { close: () => (pollClosed = true) };
		},
	};
	return {
		adapters,
		change: () => onChange?.(),
		poll: () => onPoll?.(),
		closed: () => ({ watchClosed, pollClosed }),
	};
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

		await expect(claimWriterLock("watch", lock)).rejects.toThrow(/initializ|active/i);
	});

	it("does not replace a fresh empty lock directory", async () => {
		const root = await temporaryDirectory("bridge-lock-empty-");
		const lock = path.join(root, "coordinator.lock");
		await mkdir(lock);

		await expect(claimWriterLock("watch", lock)).rejects.toThrow(/initializ|active/i);
		await expect(writeFile(path.join(lock, "owner.json"), "still owned")).resolves.toBeUndefined();
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
			claimWriterLock("watch", lock),
			claimWriterLock("watch", lock),
		]);
		const winners = contenders.filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimWriterLock>>> =>
				result.status === "fulfilled",
		);
		expect(winners).toHaveLength(1);
		await winners[0]?.value.release();
	});

	it("recovers an old malformed lock after the initialization grace period", async () => {
		const root = await temporaryDirectory("bridge-lock-malformed-stale-");
		const lock = path.join(root, "coordinator.lock");
		await mkdir(lock);
		await writeFile(path.join(lock, "owner.json"), "incomplete");
		const staleTime = new Date(Date.now() - 10_000);
		await utimes(lock, staleTime, staleTime);

		const claim = await claimWriterLock("watch", lock);
		await claim.release();
	});

	it("migrates a stale lock file left by the previous coordinator", async () => {
		const root = await temporaryDirectory("bridge-lock-legacy-");
		const lock = path.join(root, "coordinator.lock");
		await writeFile(
			lock,
			JSON.stringify({ pid: 2_147_483_647, token: "legacy", startedAt: new Date(0).toISOString() }),
		);

		const claim = await claimWriterLock("watch", lock);
		await claim.release();
	});

	it("records the declared owner intent and returns the published identity", async () => {
		const root = await temporaryDirectory("bridge-lock-owner-");
		const lock = path.join(root, "coordinator.lock");
		const claim = await claimWriterLock("watch", lock);

		expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(claim.owner);
		expect(claim.owner.mode).toBe("watch");
		await claim.release();
	});
});

describe("bridge coordinator roles", () => {
	it("makes a watch contender follow a live watch owner", async () => {
		const root = await temporaryDirectory("bridge-role-follow-");
		const lock = path.join(root, "coordinator.lock");
		await writeLiveOwner(lock, "watch");

		await expect(
			acquireCoordinatorRole("watch", { lockDirectory: lock, processIsAlive: () => true }),
		).resolves.toMatchObject({ kind: "follower", owner: { mode: "watch", token: "owner-42" } });
	});

	it("waits out a one-shot owner before becoming the watch writer", async () => {
		const root = await temporaryDirectory("bridge-role-wait-");
		const lock = path.join(root, "coordinator.lock");
		await writeLiveOwner(lock, "oneshot");
		let alive = true;

		const role = await acquireCoordinatorRole("watch", {
			lockDirectory: lock,
			processIsAlive: () => alive,
			wait: async () => {
				alive = false;
			},
		});

		expect(role.kind).toBe("writer");
		if (role.kind === "writer") await role.release();
	});

	it.each([["watch"], ["oneshot"]] satisfies ["watch" | "oneshot"][])(
		"fails a one-shot contender clearly against a live %s owner",
		async (ownerMode) => {
			const root = await temporaryDirectory(`bridge-role-exclusive-${ownerMode}-`);
			const lock = path.join(root, "coordinator.lock");
			await writeLiveOwner(lock, ownerMode);

			await expect(
				acquireCoordinatorRole("oneshot", {
					lockDirectory: lock,
					processIsAlive: () => true,
				}),
			).rejects.toThrow(/active/i);
		},
	);

	it("handles a live legacy owner conservatively with bounded grace", async () => {
		const root = await temporaryDirectory("bridge-role-legacy-");
		const lock = path.join(root, "coordinator.lock");
		await writeLiveOwner(lock, undefined);
		let now = 0;

		await expect(
			acquireCoordinatorRole("watch", {
				lockDirectory: lock,
				processIsAlive: () => true,
				now: () => now,
				wait: async (milliseconds) => {
					now += milliseconds;
				},
				unknownOwnerGraceMs: 200,
			}),
		).rejects.toThrow(/legacy lock/i);
	});
});

describe("bridge generation publication", () => {
	it("publishes generation, watch readiness, then announces", async () => {
		const root = await temporaryDirectory("bridge-publication-");
		const paths = coordinatorPaths(root);
		const record = await writeGeneration(paths, 3, "old-token");
		const announce = vi.fn();

		await publishGeneration(record, { kind: "watch", token: "current-token" }, paths, announce);

		expect(JSON.parse(await readFile(paths.generationFile, "utf8"))).toEqual(record);
		expect(JSON.parse(await readFile(paths.readyFile, "utf8"))).toEqual({
			token: "current-token",
			generation: 3,
		});
		expect(announce).toHaveBeenCalledWith(record);
	});

	it("does not announce when the readiness stamp fails", async () => {
		const root = await temporaryDirectory("bridge-publication-failure-");
		const paths = coordinatorPaths(root);
		const record = await writeGeneration(paths, 4, "old-token");
		await rm(paths.readyFile);
		await mkdir(paths.readyFile);
		const announce = vi.fn();

		await expect(
			publishGeneration(record, { kind: "watch", token: "current-token" }, paths, announce),
		).rejects.toThrow();
		expect(announce).not.toHaveBeenCalled();
	});
});

describe("bridge generation observation", () => {
	function owner(token = "writer-token"): ObservedWatchOwner {
		return {
			pid: 42,
			token,
			startedAt: new Date(0).toISOString(),
			mode: "watch",
		};
	}

	it("rejects stale or mismatched readiness until token and generation both match", async () => {
		const root = await temporaryDirectory("bridge-observer-readiness-");
		const paths = coordinatorPaths(root);
		const watchOwner = owner();
		await writeGeneration(paths, 7, "prior-session");
		await writeObserverOwner(paths, watchOwner);
		const harness = observationHarness();
		const records: GenerationRecord[] = [];
		const subscription = new GenerationObserver(watchOwner, {
			paths,
			adapters: harness.adapters,
			processIsAlive: () => true,
		}).observe((record) => records.push(record));

		harness.poll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(records).toHaveLength(0);

		await writeFile(paths.readyFile, JSON.stringify({ token: "writer-token", generation: 6 }));
		harness.change();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(records).toHaveLength(0);

		await writeFile(paths.readyFile, JSON.stringify({ token: "writer-token", generation: 7 }));
		await writeObserverOwner(paths, owner("replacement-token"));
		harness.change();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(records).toHaveLength(0);

		await writeObserverOwner(paths, watchOwner);
		harness.change();
		await vi.waitFor(() => expect(records.map((record) => record.generation)).toEqual([7]));
		subscription.close();
	});

	it("deduplicates repeated scans and converges to the newest coalesced generation", async () => {
		const root = await temporaryDirectory("bridge-observer-coalesced-");
		const paths = coordinatorPaths(root);
		const watchOwner = owner();
		await writeObserverOwner(paths, watchOwner);
		const harness = observationHarness();
		const records: GenerationRecord[] = [];
		const subscription = new GenerationObserver(watchOwner, {
			paths,
			adapters: harness.adapters,
			processIsAlive: () => true,
		}).observe((record) => records.push(record));

		await writeGeneration(paths, 8, "writer-token");
		await writeGeneration(paths, 9, "writer-token");
		harness.change();
		await vi.waitFor(() => expect(records.map((record) => record.generation)).toEqual([9]));
		harness.change();
		harness.poll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(records.map((record) => record.generation)).toEqual([9]);

		subscription.close();
		expect(harness.closed()).toEqual({ watchClosed: true, pollClosed: true });
	});

	it("falls back to polling when the state directory temporarily does not exist", async () => {
		const root = await temporaryDirectory("bridge-observer-enoent-");
		const paths = coordinatorPaths(root);
		const watchOwner = owner();
		await writeObserverOwner(paths, watchOwner);
		let poll: () => void = () => {
			throw new Error("poll callback was not registered");
		};
		let pollClosed = false;
		const adapters: GenerationObserverAdapters = {
			watchDirectory: () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" });
			},
			schedulePoll: (callback) => {
				poll = callback;
				return { close: () => (pollClosed = true) };
			},
		};
		const records: GenerationRecord[] = [];
		const subscription = new GenerationObserver(watchOwner, {
			paths,
			adapters,
			processIsAlive: () => true,
		}).observe((record) => records.push(record));

		await writeGeneration(paths, 1, "writer-token");
		poll();
		await vi.waitFor(() => expect(records.map((record) => record.generation)).toEqual([1]));
		subscription.close();
		expect(pollClosed).toBe(true);
	});

	it("relays initial and later generations and closes when the writer exits", async () => {
		const root = await temporaryDirectory("bridge-follower-relay-");
		const paths = coordinatorPaths(root);
		const watchOwner = owner();
		await writeGeneration(paths, 1, watchOwner.token);
		await writeObserverOwner(paths, watchOwner);
		const harness = observationHarness();
		const observer = new GenerationObserver(watchOwner, {
			paths,
			adapters: harness.adapters,
			processIsAlive: () => true,
		});
		let checkLiveness: () => void = () => {
			throw new Error("liveness callback was not registered");
		};
		let livenessClosed = false;
		let writerAlive = true;
		const announced = vi.fn();
		const following = followGenerations(watchOwner, {
			observer,
			processIsAlive: () => writerAlive,
			monitorLiveness: (check): Closeable => {
				checkLiveness = check;
				return { close: () => (livenessClosed = true) };
			},
			announce: announced,
		});
		await vi.waitFor(() => expect(announced).toHaveBeenCalledTimes(1));

		await writeGeneration(paths, 2, watchOwner.token);
		harness.change();
		await vi.waitFor(() => expect(announced).toHaveBeenCalledTimes(2));
		expect(announced.mock.calls.map(([record]) => record.generation)).toEqual([1, 2]);

		writerAlive = false;
		checkLiveness();
		await expect(following).rejects.toThrow(/cannot promote/i);
		expect(livenessClosed).toBe(true);
		expect(harness.closed()).toEqual({ watchClosed: true, pollClosed: true });
	});
});

describe("bridge coordinator main seam", () => {
	it("does not clean outputs when a one-shot encounters a live watch", async () => {
		const root = await temporaryDirectory("bridge-main-exclusive-");
		const paths = coordinatorPaths(root);
		await Promise.all([
			mkdir(paths.distDir, { recursive: true }),
			mkdir(paths.stateDir, { recursive: true }),
		]);
		await writeFile(path.join(paths.distDir, "sentinel.txt"), "keep dist");
		await writeFile(paths.generationFile, "keep generation");
		const writer = await claimWriterLock("watch", paths.lockDirectory);

		try {
			await expect(runCoordinator(["--clean"], { paths })).rejects.toThrow(
				/stop the bridge watch/i,
			);
			expect(await readFile(path.join(paths.distDir, "sentinel.txt"), "utf8")).toBe("keep dist");
			expect(await readFile(paths.generationFile, "utf8")).toBe("keep generation");
		} finally {
			await writer.release();
		}
	});
});

describe("bridge generation build loop", () => {
	it("reconciles an edit that arrives during the initial build", async () => {
		const initialBuild = deferred();
		const fingerprints = ["initial", "edited"];
		const buildNextGeneration = vi
			.fn<(fingerprint: string) => Promise<void>>()
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

	it("skips the rebuild when seeded with the current fingerprint", async () => {
		let fingerprint = "seeded";
		const buildNextGeneration = vi.fn<(fingerprint: string) => Promise<void>>(async () => {});
		const reportFailure = vi.fn();
		const loop = new GenerationBuildLoop(
			async () => fingerprint,
			buildNextGeneration,
			reportFailure,
		);

		loop.seed("seeded");
		await loop.request();
		expect(buildNextGeneration).not.toHaveBeenCalled();

		fingerprint = "edited";
		await loop.request();
		expect(buildNextGeneration).toHaveBeenCalledTimes(1);
		expect(buildNextGeneration).toHaveBeenCalledWith("edited");
		expect(reportFailure).not.toHaveBeenCalled();
	});

	// Shutdown awaits waitForIdle() before releasing the writer lock so a
	// replacement writer cannot start while the old build is still staging or
	// promoting output.
	it("waitForIdle stays pending until an in-flight build settles", async () => {
		const build = deferred();
		const buildNextGeneration = vi
			.fn<(fingerprint: string) => Promise<void>>()
			.mockReturnValue(build.promise);
		const reportFailure = vi.fn();
		const loop = new GenerationBuildLoop(async () => "initial", buildNextGeneration, reportFailure);

		void loop.request();
		await vi.waitFor(() => expect(buildNextGeneration).toHaveBeenCalledOnce());

		let settled = false;
		const idle = loop.waitForIdle().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);

		build.resolve();
		await idle;
		expect(settled).toBe(true);
		expect(reportFailure).not.toHaveBeenCalled();
	});
});

describe("bridge generation reuse", () => {
	async function liveGeneration(files: Record<string, string>, fingerprint: string) {
		const root = await temporaryDirectory("bridge-reuse-");
		const live = path.join(root, "dist");
		await mkdir(live, { recursive: true });
		const digests: Record<string, string> = {};
		for (const [name, content] of Object.entries(files)) {
			await writeFile(path.join(live, name), content);
			digests[name] = createHash("sha256").update(content).digest("hex");
		}
		const recordFile = path.join(root, "generation.json");
		const record = {
			generation: 7,
			inputFingerprint: fingerprint,
			manifest: Object.keys(files).sort(),
			digests,
			completedAt: new Date().toISOString(),
		};
		await writeFile(recordFile, JSON.stringify(record));
		return { live, recordFile, digests };
	}

	it("reuses a generation whose inputs and live outputs are unchanged", async () => {
		const { live, recordFile } = await liveGeneration({ "index.js": "export {};" }, "fp");
		await expect(reusableGeneration("fp", live, recordFile)).resolves.toMatchObject({
			generation: 7,
		});
	});

	it("rejects reuse when the recorded input fingerprint differs", async () => {
		const { live, recordFile } = await liveGeneration({ "index.js": "export {};" }, "fp");
		await expect(reusableGeneration("other", live, recordFile)).resolves.toBeNull();
	});

	it("rejects reuse when a live output was modified", async () => {
		const { live, recordFile } = await liveGeneration({ "index.js": "export {};" }, "fp");
		await writeFile(path.join(live, "index.js"), "tampered");
		await expect(reusableGeneration("fp", live, recordFile)).resolves.toBeNull();
	});

	it("rejects reuse when a live output is missing", async () => {
		const { live, recordFile } = await liveGeneration(
			{ "index.js": "export {};", "chunk.js": "export const chunk = 1;" },
			"fp",
		);
		await rm(path.join(live, "chunk.js"));
		await expect(reusableGeneration("fp", live, recordFile)).resolves.toBeNull();
	});

	it("rejects reuse of a legacy record without a fingerprint", async () => {
		const { live, recordFile, digests } = await liveGeneration({ "index.js": "export {};" }, "fp");
		await writeFile(
			recordFile,
			JSON.stringify({
				generation: 7,
				manifest: ["index.js"],
				digests,
				completedAt: new Date().toISOString(),
			}),
		);
		await expect(reusableGeneration("fp", live, recordFile)).resolves.toBeNull();
	});
});

describe("launcher death-pipe", () => {
	const packageDir = fileURLToPath(new URL("..", import.meta.url));
	const childFixture = fileURLToPath(new URL("./fixtures/death-pipe-child.ts", import.meta.url));

	interface ChildOutcome {
		code: number | null;
		output: string;
	}

	// Spawns the real death-pipe child against a given stdin and resolves with its
	// exit code and stdout. Rejects if the child fails to exit — the failure mode
	// a missing `unref()` would produce (the pipe stays open, so a still-refed
	// stdin listener would keep the event loop alive forever).
	function runChild(stdin: "pipe" | "ignore"): Promise<ChildOutcome> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", childFixture], {
				cwd: packageDir,
				stdio: [stdin, "pipe", "inherit"],
			});
			let output = "";
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`death-pipe child never exited; output: ${JSON.stringify(output)}`));
			}, 15_000);
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.on("exit", (code) => {
				clearTimeout(timeout);
				resolve({ code, output });
			});
		});
	}

	function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
		return new Promise((resolve, reject) => {
			let output = "";
			const timeout = setTimeout(
				() => reject(new Error(`child never signalled ready; output: ${JSON.stringify(output)}`)),
				15_000,
			);
			child.stdout?.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("ready")) {
					clearTimeout(timeout);
					resolve();
				}
			});
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	// Mode 1: the real launcher-death topology. An abnormally-dying launcher
	// closes every pipe end it held — the stdin write end (which delivers EOF and
	// arms the stop) AND the stdout/stderr read ends. The coordinator's shutdown
	// output then hits a broken pipe, so this is the regression for the EPIPE
	// crash: without the guard, the unhandled EPIPE aborts the child before its
	// asynchronous cleanup writes the on-disk marker. It also automatically
	// guards the empirical fact that Node's piped stdin is a socket (Unix) / FIFO
	// (Windows) that `launcherPipeIsArmable` must accept — otherwise nothing arms
	// and the marker is never written.
	it("completes asynchronous cleanup when the launcher dies mid-output", async () => {
		const markerDirectory = await temporaryDirectory("bridge-death-pipe-");
		const markerPath = path.join(markerDirectory, "cleanup-done");
		const child = spawn(process.execPath, ["--import", "tsx", childFixture, markerPath], {
			cwd: packageDir,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("exit", (code) => resolve(code));
			child.once("error", reject);
		});
		await waitForReady(child);

		// Close every pipe end the launcher owned, as its death would.
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.stdin?.end();

		const code = await exited;
		expect(existsSync(markerPath)).toBe(true);
		expect(code).toBe(0);
	}, 20_000);

	// Mode 2: with the write end held open, the armed, resumed, unref'd stdin
	// listener must not keep the event loop alive — the child exits on its own
	// once its work finishes, without firing the handler.
	it("does not keep the process alive while the pipe stays open", async () => {
		const { code, output } = await runChild("pipe");
		expect(output).not.toContain("launcher-gone");
		expect(code).toBe(0);
	}, 20_000);

	// Mode 3: `stdio: "ignore"` gives the child `/dev/null`, whose immediate EOF
	// must not be mistaken for a launcher death — a character device is not
	// armable, so nothing is attached.
	it("does not arm on a non-pipe stdin", async () => {
		const { code, output } = await runChild("ignore");
		expect(output).not.toContain("launcher-gone");
		expect(code).toBe(0);
	}, 20_000);
});
