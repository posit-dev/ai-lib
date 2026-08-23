/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { fork } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createSingleFileStoreFixture,
	type SingleFileStoreFixture,
} from "../../../tests/helpers/single-file-store-fixture.js";
import { SingleFileStore } from "../SingleFileStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

describe("SingleFileStore", () => {
	let fixture: SingleFileStoreFixture;
	let store: SingleFileStore;

	beforeEach(() => {
		fixture = createSingleFileStoreFixture("credential-store-test-");
		store = fixture.store;
	});

	afterEach(() => {
		fixture.cleanup();
	});

	// ========================================================================
	// Basic operations
	// ========================================================================

	describe("basic operations", () => {
		it("should set and get a value", async () => {
			await store.set("key1", { foo: "bar" });
			const result = await store.get<{ foo: string }>("key1");
			expect(result).toEqual({ foo: "bar" });
		});

		it("should return undefined for missing key", async () => {
			const result = await store.get("nonexistent");
			expect(result).toBeUndefined();
		});

		it("should delete a key", async () => {
			await store.set("key1", "value1");
			await store.delete("key1");
			const result = await store.get("key1");
			expect(result).toBeUndefined();
		});

		it("should clear all data", async () => {
			await store.set("key1", "value1");
			await store.set("key2", "value2");
			await store.clear();
			expect(await store.get("key1")).toBeUndefined();
			expect(await store.get("key2")).toBeUndefined();
		});

		it("should list keys", async () => {
			await store.set("key1", "value1");
			await store.set("key2", "value2");
			const keys = await store.keys();
			expect(keys.sort()).toEqual(["key1", "key2"]);
		});

		it("should support namespaced keys", async () => {
			await store.set("auth:positai:oauth", { token: "abc" });
			await store.set("auth:anthropic:apikey", { key: "sk-123" });
			const result = await store.get<{ token: string }>("auth:positai:oauth");
			expect(result).toEqual({ token: "abc" });
		});

		it("should work without a logger", async () => {
			const noLoggerStore = new SingleFileStore({
				filePath: path.join(fixture.directory, "no-logger.json"),
			});
			await noLoggerStore.set("key", "value");
			expect(await noLoggerStore.get("key")).toBe("value");
		});
	});

	// ========================================================================
	// Write lock serialization
	// ========================================================================

	describe("write lock serialization", () => {
		it("should serialize concurrent writes to prevent lost updates", async () => {
			const writes = Promise.all([
				store.set("key1", "value1"),
				store.set("key2", "value2"),
				store.set("key3", "value3"),
			]);

			await writes;

			expect(await store.get("key1")).toBe("value1");
			expect(await store.get("key2")).toBe("value2");
			expect(await store.get("key3")).toBe("value3");
		});

		it("should serialize interleaved set and delete operations", async () => {
			await store.set("key1", "initial");

			const ops = Promise.all([
				store.set("key2", "value2"),
				store.delete("key1"),
				store.set("key3", "value3"),
			]);

			await ops;

			expect(await store.get("key1")).toBeUndefined();
			expect(await store.get("key2")).toBe("value2");
			expect(await store.get("key3")).toBe("value3");
		});

		it("should handle rapid sequential writes correctly", async () => {
			for (let i = 0; i < 10; i++) {
				await store.set("counter", i);
			}
			expect(await store.get("counter")).toBe(9);
		});

		it("serializes writes even with many concurrent operations", async () => {
			const numWrites = 20;
			const writes = [];

			for (let i = 0; i < numWrites; i++) {
				writes.push(store.set(`stress-key-${i}`, `value-${i}`));
			}

			await Promise.all(writes);

			const keys = await store.keys();
			expect(keys.length).toBe(numWrites);

			expect(await store.get("stress-key-0")).toBe("value-0");
			expect(await store.get("stress-key-10")).toBe("value-10");
			expect(await store.get(`stress-key-${numWrites - 1}`)).toBe(`value-${numWrites - 1}`);
		});
	});

	// ========================================================================
	// Atomic writes
	// ========================================================================

	describe("atomic writes", () => {
		it("should use temp file with PID for atomic writes", async () => {
			await store.set("key", "value");

			const files = await fs.readdir(fixture.directory);
			expect(files).toContain("data.json");
			expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
		});

		it("should handle file not existing initially", async () => {
			const result = await store.get("key");
			expect(result).toBeUndefined();

			await store.set("key", "value");
			expect(await store.get("key")).toBe("value");
		});

		it("should create nested directories", async () => {
			const nestedStore = new SingleFileStore(
				{ filePath: path.join(fixture.directory, "a", "b", "c", "data.json") },
				mockLogger,
			);
			await nestedStore.set("key", "value");
			expect(await nestedStore.get("key")).toBe("value");
		});
	});

	// ========================================================================
	// Corruption tolerance
	// ========================================================================

	describe("corruption tolerance", () => {
		it("should recover from corrupted JSON file", async () => {
			await fs.mkdir(fixture.directory, { recursive: true });
			await fs.writeFile(fixture.filePath, "not valid json{{{");

			const result = await store.get("key");
			expect(result).toBeUndefined();

			await store.set("key", "value");
			expect(await store.get("key")).toBe("value");
		});
	});

	// ========================================================================
	// Cross-process locking (withLock)
	// ========================================================================

	describe("withLock", () => {
		it("should execute function under lock and return result", async () => {
			const result = await store.withLock(async () => {
				return 42;
			});
			expect(result).toBe(42);
		});

		it("should allow reading/writing inside the lock", async () => {
			await store.set("before", "yes");

			await store.withLock(async () => {
				const val = await store.get("before");
				expect(val).toBe("yes");
			});
		});

		it("should create the store file if it doesn't exist before locking", async () => {
			const newStore = new SingleFileStore(
				{ filePath: path.join(fixture.directory, "newdir", "store.json") },
				mockLogger,
			);

			await newStore.withLock(async () => {
				// File should exist now
				const exists = await fs
					.access(path.join(fixture.directory, "newdir", "store.json"))
					.then(() => true)
					.catch(() => false);
				expect(exists).toBe(true);
			});
		});

		it("should propagate errors from locked function", async () => {
			await expect(
				store.withLock(async () => {
					throw new Error("test error");
				}),
			).rejects.toThrow("test error");
		});

		it("should release lock even on error", async () => {
			// First lock: throws
			await expect(
				store.withLock(async () => {
					throw new Error("fail");
				}),
			).rejects.toThrow();

			// Second lock: should succeed (lock was released)
			const result = await store.withLock(async () => "ok");
			expect(result).toBe("ok");
		});
	});

	// ========================================================================
	// File watching
	// ========================================================================

	describe("watch", () => {
		it("should fire handler when file changes", async () => {
			// Write initial data so the file exists
			await store.set("initial", "value");

			let resolveEvent!: () => void;
			const event = new Promise<void>((resolve) => {
				resolveEvent = resolve;
			});
			const handler = vi.fn(resolveEvent);
			const watcher = store.watch(handler);

			expect(watcher.ready).toBeInstanceOf(Promise);
			await watcher.ready;

			// Modify the file externally
			const data = JSON.parse(await fs.readFile(fixture.filePath, "utf-8"));
			data.external = "change";
			await fs.writeFile(fixture.filePath, JSON.stringify(data));

			await event;
			expect(handler).toHaveBeenCalled();

			watcher.dispose();
		});

		it("should stop firing after dispose", async () => {
			await store.set("initial", "value");

			const handler = vi.fn();
			const watcher = store.watch(handler);

			expect(watcher.ready).toBeInstanceOf(Promise);
			await watcher.ready;
			watcher.dispose();

			// Modify the file after dispose
			await fs.writeFile(fixture.filePath, JSON.stringify({ after: "dispose" }));

			// Wait to ensure handler is NOT called
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(handler).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Cross-process lock contention
	// ========================================================================

	describe("cross-process withLock contention", () => {
		it("should retry and acquire lock after child process releases", async () => {
			const storePath = fixture.filePath;
			// Ensure the store file exists
			await store.set("init", true);

			// Fork a child that holds the lock and waits for a release signal
			const helperScript = path.join(__dirname, "helpers", "lock-holder.ts");
			const child = fork(helperScript, [storePath], {
				execArgv: ["--import", "tsx"],
				stdio: ["pipe", "pipe", "pipe", "ipc"],
			});
			let childStderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				childStderr += chunk.toString();
			});

			const childReady = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`Child did not acquire lock in time: ${childStderr}`)),
					5000,
				);
				child.on("message", (msg) => {
					if (msg === "lock-acquired") {
						clearTimeout(timeout);
						resolve();
					}
				});
				child.on("error", (err) => {
					clearTimeout(timeout);
					reject(err);
				});
			});
			const lockReleased = new Promise<void>((resolve) => {
				child.on("message", (msg) => {
					if (msg === "lock-released") resolve();
				});
			});
			const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(resolve) => {
					child.once("exit", (code, signal) => resolve({ code, signal }));
				},
			);
			let releaseTimer: ReturnType<typeof setTimeout> | undefined;
			let killGuard: ReturnType<typeof setTimeout> | undefined;

			try {
				await childReady;

				// Keep real contention: the parent starts acquiring while the child
				// continues to hold the lock for this interval.
				releaseTimer = setTimeout(() => {
					child.send("release");
					killGuard = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) child.kill();
					}, 2000);
				}, 200);

				const result = await store.withLock(async () => "parent-acquired");
				expect(result).toBe("parent-acquired");

				await lockReleased;
				const exit = await childExit;
				expect(exit).toEqual({ code: 0, signal: null });
				expect(childStderr).toBe("");
			} finally {
				if (releaseTimer) clearTimeout(releaseTimer);
				if (killGuard) clearTimeout(killGuard);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill();
					await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 1000))]);
				}
			}
		}, 10000);
	});

	// ========================================================================
	// Atomic-rename watch
	// ========================================================================

	describe("atomic-rename watch", () => {
		it("should fire watcher on temp-file + rename (atomic write pattern)", async () => {
			const storePath = fixture.filePath;
			// Ensure the file exists first
			await store.set("initial", "value");

			let resolveEvent!: () => void;
			const event = new Promise<void>((resolve) => {
				resolveEvent = resolve;
			});
			const handler = vi.fn(resolveEvent);
			const watcher = store.watch(handler);

			expect(watcher.ready).toBeInstanceOf(Promise);
			await watcher.ready;

			// Simulate the atomic write pattern: write to temp file, then rename
			const tempFile = `${storePath}.tmp.${process.pid}`;
			await fs.writeFile(tempFile, JSON.stringify({ atomicWrite: true }));
			await fs.rename(tempFile, storePath);

			await event;
			expect(handler).toHaveBeenCalled();

			watcher.dispose();
		});
	});

	// ========================================================================
	// Secure permissions (Unix only)
	// ========================================================================

	if (process.platform !== "win32") {
		describe("secure permissions (Unix)", () => {
			it("should set 0o600 permissions on store file", async () => {
				await store.set("key", "value");

				const stats = await fs.stat(fixture.filePath);
				const mode = stats.mode & 0o777;
				expect(mode).toBe(0o600);
			});

			it("should set 0o700 permissions on directory", async () => {
				const nestedStore = new SingleFileStore(
					{ filePath: path.join(fixture.directory, "secure-dir", "data.json") },
					mockLogger,
				);
				await nestedStore.set("key", "value");

				const stats = await fs.stat(path.join(fixture.directory, "secure-dir"));
				const mode = stats.mode & 0o777;
				expect(mode).toBe(0o700);
			});
		});
	}
});
