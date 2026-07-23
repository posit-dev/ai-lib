/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single-File Key-Value Secret Store
 *
 * A generic, typed key-value store backed by a single JSON file. Designed for
 * storing small amounts of secret data (OAuth tokens, API keys, credentials).
 *
 * Features:
 * - Atomic writes (temp file + rename) to prevent partial writes
 * - In-process mutex serializes read-modify-write operations (prevents lost updates)
 * - Unique temp files per write to avoid rename collisions between concurrent writers
 * - Secure file permissions (0o600) on Unix
 * - Corruption-tolerant: parse errors result in empty store, next write recovers
 * - Cross-process locking via `withLock(fn)` for multi-process critical sections
 * - File watching via `watch(handler)` with debounced change notifications
 *
 * This package is **generic** — it owns where and how bytes hit disk, but has
 * no knowledge of credential meaning, provider vocabulary, or auth semantics.
 * The store is type-parametric: callers provide their own value types via
 * `get<T>()` / `set<T>()`.
 *
 * Invariant: no imports from `@assistant/*`, `ai-config`, `ai-provider-bridge`,
 * or any SDK package. Dependencies are limited to `fs`/`path` + `chokidar` +
 * `proper-lockfile`.
 */

import { promises as fs } from "fs";
import * as path from "path";

import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import lockfile from "proper-lockfile";

import type { Disposable, LoggerLike, SingleFileStoreConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Lock options for cross-process locking
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_OPTIONS = {
	retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
	stale: 10000, // Consider lock stale after 10 seconds (handles crashes)
};

// ---------------------------------------------------------------------------
// SingleFileStore
// ---------------------------------------------------------------------------

/**
 * Key-value store backed by a single JSON file.
 *
 * The key API uses plain strings. To allow future namespacing (e.g. multi-
 * product stores sharing one file), keys should be structured using a
 * convention like `namespace:key` — the store treats them as opaque strings.
 */
export class SingleFileStore {
	private readonly filePath: string;
	private readonly logger: LoggerLike | undefined;
	private readonly shouldEnforcePermissions = process.platform !== "win32";
	// In-process mutex to serialize read-modify-write operations
	private writePromise: Promise<void> = Promise.resolve();

	constructor(config: SingleFileStoreConfig, logger?: LoggerLike) {
		this.filePath = config.filePath;
		this.logger = logger;
	}

	// ========================================================================
	// Read operations
	// ========================================================================

	/**
	 * Get a value by key.
	 */
	async get<T>(key: string): Promise<T | undefined> {
		const data = await this.readStore();
		return data[key] as T | undefined;
	}

	/**
	 * Get all keys in the store.
	 */
	async keys(): Promise<string[]> {
		const data = await this.readStore();
		return Object.keys(data);
	}

	// ========================================================================
	// Write operations
	// ========================================================================

	/**
	 * Set a value by key.
	 * Uses an in-process mutex to serialize read-modify-write operations.
	 */
	async set<T>(key: string, value: T): Promise<void> {
		await this.withWriteLock(async () => {
			const data = await this.readStore();
			data[key] = value;
			await this.writeStore(data);
		});
	}

	/**
	 * Delete a key.
	 * Uses an in-process mutex to serialize read-modify-write operations.
	 */
	async delete(key: string): Promise<void> {
		await this.withWriteLock(async () => {
			const data = await this.readStore();
			delete data[key];
			await this.writeStore(data);
		});
	}

	/**
	 * Clear all data.
	 * Uses an in-process mutex to serialize write operations.
	 */
	async clear(): Promise<void> {
		await this.withWriteLock(async () => {
			await this.writeStore({});
		});
	}

	// ========================================================================
	// Cross-process locking
	// ========================================================================

	/**
	 * Execute `fn` while holding a cross-process file lock on the store.
	 *
	 * The store owns the **lock primitive** — the caller decides the **scope**
	 * (which operation is critical). For example, RStudio wraps entire auth
	 * operations in `withLock`, not individual store writes.
	 *
	 * The lock uses `proper-lockfile` with stale-lock handling: a lock held
	 * for more than 10 seconds is considered stale and can be reclaimed.
	 *
	 * @param fn - The function to execute under the lock.
	 * @returns The return value of `fn`.
	 */
	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.filePath, DEFAULT_LOCK_OPTIONS);
			this.logger?.debug("[SingleFileStore] Acquired cross-process lock");
			return await fn();
		} finally {
			if (release) {
				await release();
				this.logger?.debug("[SingleFileStore] Released cross-process lock");
			}
		}
	}

	// ========================================================================
	// File watching
	// ========================================================================

	/**
	 * Watch the store file for changes. Returns a `Disposable` that stops
	 * watching when `dispose()` is called.
	 *
	 * Uses chokidar with `awaitWriteFinish` to correctly handle the atomic
	 * write pattern (temp file + rename). Fires on both `change` and `add`
	 * events since the rename may appear as an add.
	 *
	 * @param handler - Called when the store file is modified externally.
	 * @returns Disposable that stops the watcher.
	 */
	watch(handler: () => void): Disposable {
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;

		const debouncedHandler = () => {
			if (disposed) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				if (!disposed) handler();
			}, 200);
		};

		let watcher: FSWatcher | undefined;

		// Ensure the file exists before starting the watcher.
		// Catch initialization failures so the promise rejection is never unhandled.
		void this.ensureFileExists()
			.then(() => {
				if (disposed) return;

				watcher = chokidarWatch(this.filePath, {
					persistent: true,
					ignoreInitial: true,
					awaitWriteFinish: {
						stabilityThreshold: 100,
						pollInterval: 50,
					},
				});

				// Use 'all' event and filter to handle both 'change' and 'add' events
				// (atomic writes use temp file + rename, which may emit 'add' instead of 'change')
				watcher.on("all", (eventName) => {
					if (eventName === "change" || eventName === "add") {
						debouncedHandler();
					}
				});

				watcher.on("error", (error) => {
					this.logger?.warn(`[SingleFileStore] File watcher error: ${error}`);
				});

				this.logger?.debug(`[SingleFileStore] Started watching: ${this.filePath}`);
			})
			.catch((error) => {
				this.logger?.warn(
					`[SingleFileStore] Failed to initialize file watcher for ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});

		return {
			dispose: () => {
				disposed = true;
				if (debounceTimer) clearTimeout(debounceTimer);
				void watcher?.close();
			},
		};
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	/**
	 * Execute a function while holding the in-process write lock.
	 * Serializes all write operations to prevent read-modify-write races.
	 *
	 * WARNING: Not re-entrant. Do not call set/delete/clear from within the
	 * callback, as this will deadlock.
	 */
	private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		// Chain this operation after any pending writes
		const previousPromise = this.writePromise;
		let resolve: () => void;
		this.writePromise = new Promise<void>((r) => {
			resolve = r;
		});

		try {
			// Wait for previous write to complete
			await previousPromise;
			// Execute our read-modify-write
			return await fn();
		} finally {
			// Release the lock for the next writer
			resolve!();
		}
	}

	/**
	 * Read and parse the store file.
	 * Returns empty object on missing file or parse error.
	 */
	private async readStore(): Promise<Record<string, unknown>> {
		try {
			const content = await fs.readFile(this.filePath, "utf-8");
			// Fix permissions on existing files
			await this.ensurePermissions(this.filePath, 0o600);
			return JSON.parse(content) as Record<string, unknown>;
		} catch (error) {
			// File doesn't exist - return empty store
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {};
			}

			// Parse error or other read error - log and return empty store
			// The next set() will overwrite with valid JSON
			this.logger?.warn(
				`[SingleFileStore] Failed to read/parse ${this.filePath}: ${error instanceof Error ? error.message : String(error)}. Treating as empty store.`,
			);
			return {};
		}
	}

	/**
	 * Write the store atomically with secure permissions.
	 * Uses temp file + rename pattern with unique temp file names
	 * to avoid rename collisions between concurrent writers.
	 */
	private async writeStore(data: Record<string, unknown>): Promise<void> {
		const dir = path.dirname(this.filePath);
		// Use PID in temp file name to avoid collisions between processes
		const tempPath = `${this.filePath}.tmp.${process.pid}`;

		// Ensure directory exists with secure permissions
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await this.ensurePermissions(dir, 0o700);

		try {
			// Write to temp file with secure permissions
			await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await this.ensurePermissions(tempPath, 0o600);

			// Atomic rename
			await fs.rename(tempPath, this.filePath);
		} finally {
			// Clean up temp file if it still exists (e.g., if rename failed)
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore - file was likely already renamed or doesn't exist
			}
		}
	}

	/**
	 * Ensure the store file exists (lockfile and watcher require it).
	 */
	private async ensureFileExists(): Promise<void> {
		const dir = path.dirname(this.filePath);
		try {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			await this.ensurePermissions(dir, 0o700);
		} catch {
			// Directory may already exist
		}

		try {
			await fs.access(this.filePath);
		} catch {
			// File doesn't exist — create it with an empty store
			await fs.writeFile(this.filePath, JSON.stringify({}, null, 2), {
				encoding: "utf-8",
				mode: 0o600,
			});
			await this.ensurePermissions(this.filePath, 0o600);
		}
	}

	/**
	 * Ensure file/directory permissions are correct (Unix only).
	 */
	private async ensurePermissions(filePath: string, mode: number): Promise<void> {
		if (!this.shouldEnforcePermissions) {
			return;
		}

		try {
			const stats = await fs.lstat(filePath);
			if (stats.isSymbolicLink()) {
				return; // Skip symlinks
			}

			const currentMode = stats.mode & 0o777;
			if (currentMode !== mode) {
				await fs.chmod(filePath, mode);
			}
		} catch (error) {
			// Tolerate ENOENT silently (race condition)
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			this.logger?.debug(`[SingleFileStore] Failed to set permissions on ${filePath}: ${error}`);
		}
	}
}
