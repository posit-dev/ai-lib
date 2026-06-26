/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SingleFileStore } from "../SingleFileStore";

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

describe("SingleFileStore", () => {
	let tempDir: string;
	let store: SingleFileStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "credential-store-test-"));
		store = new SingleFileStore({ filePath: path.join(tempDir, "data.json") }, mockLogger);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
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
				filePath: path.join(tempDir, "no-logger.json"),
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

			const files = await fs.readdir(tempDir);
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
				{ filePath: path.join(tempDir, "a", "b", "c", "data.json") },
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
			await fs.mkdir(tempDir, { recursive: true });
			await fs.writeFile(path.join(tempDir, "data.json"), "not valid json{{{");

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
				{ filePath: path.join(tempDir, "newdir", "store.json") },
				mockLogger,
			);

			await newStore.withLock(async () => {
				// File should exist now
				const exists = await fs
					.access(path.join(tempDir, "newdir", "store.json"))
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

			const handler = vi.fn();
			const watcher = store.watch(handler);

			// Wait for watcher to initialize
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Modify the file externally
			const data = JSON.parse(await fs.readFile(path.join(tempDir, "data.json"), "utf-8"));
			data.external = "change";
			await fs.writeFile(path.join(tempDir, "data.json"), JSON.stringify(data));

			// Wait for debounced handler
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(handler).toHaveBeenCalled();

			watcher.dispose();
		});

		it("should stop firing after dispose", async () => {
			await store.set("initial", "value");

			const handler = vi.fn();
			const watcher = store.watch(handler);

			// Wait for watcher to initialize
			await new Promise((resolve) => setTimeout(resolve, 300));

			watcher.dispose();

			// Modify the file after dispose
			await fs.writeFile(path.join(tempDir, "data.json"), JSON.stringify({ after: "dispose" }));

			// Wait to ensure handler is NOT called
			await new Promise((resolve) => setTimeout(resolve, 500));

			expect(handler).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Secure permissions (Unix only)
	// ========================================================================

	if (process.platform !== "win32") {
		describe("secure permissions (Unix)", () => {
			it("should set 0o600 permissions on store file", async () => {
				await store.set("key", "value");

				const stats = await fs.stat(path.join(tempDir, "data.json"));
				const mode = stats.mode & 0o777;
				expect(mode).toBe(0o600);
			});

			it("should set 0o700 permissions on directory", async () => {
				const nestedStore = new SingleFileStore(
					{ filePath: path.join(tempDir, "secure-dir", "data.json") },
					mockLogger,
				);
				await nestedStore.set("key", "value");

				const stats = await fs.stat(path.join(tempDir, "secure-dir"));
				const mode = stats.mode & 0o777;
				expect(mode).toBe(0o700);
			});
		});
	}
});
