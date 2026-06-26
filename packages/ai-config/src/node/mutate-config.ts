/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-process-safe mutation of providers.json.
 *
 * Acquires a cross-process lockfile, re-reads the current state, applies the
 * caller's mutation, validates the result, and performs an atomic write
 * (temp file + rename). Stale locks (>10s) are reclaimed.
 *
 * An in-process serialized queue provides the inner layer so concurrent
 * mutations from the same process are ordered.
 */

import { promises as fs } from "fs";
import * as path from "path";

import lockfile from "proper-lockfile";

import { providersConfigSchema } from "../schema";
import type { ProvidersConfig } from "../types";
import { PROVIDERS_CONFIG_PATH } from "./paths";
import type { LoggerLike, MutateConfigOptions } from "./types";

// ---------------------------------------------------------------------------
// Lock options
// ---------------------------------------------------------------------------

const LOCK_OPTIONS = {
	retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
	stale: 10000, // Consider lock stale after 10 seconds (handles crashes)
	lockfilePath: undefined as string | undefined, // set at call time
};

// ---------------------------------------------------------------------------
// In-process serialization queue
// ---------------------------------------------------------------------------

/**
 * Per-path in-process write queue to serialize concurrent mutations from
 * the same process. The cross-process lockfile handles inter-process safety.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueue(configPath: string, fn: () => Promise<void>): Promise<void> {
	const current = writeQueues.get(configPath) ?? Promise.resolve();
	const next = current.then(fn, fn); // always chain, even on error
	writeQueues.set(configPath, next);
	return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a mutation to providers.json in a cross-process-safe manner.
 *
 * The `mutator` receives the current validated config and returns the new
 * config to write. The mutator may return the same object to indicate
 * no change — the write is still performed (idempotent).
 *
 * @param mutator - A function that transforms the current config.
 * @param opts - Optional path override and logger.
 */
export async function mutateProvidersConfig(
	mutator: (current: ProvidersConfig) => ProvidersConfig | Promise<ProvidersConfig>,
	opts?: MutateConfigOptions,
): Promise<void> {
	const configPath = opts?.configPath ?? PROVIDERS_CONFIG_PATH;
	const logger = opts?.logger;

	await enqueue(configPath, async () => {
		await performLockedMutation(configPath, mutator, logger);
	});
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function performLockedMutation(
	configPath: string,
	mutator: (current: ProvidersConfig) => ProvidersConfig | Promise<ProvidersConfig>,
	logger: LoggerLike | undefined,
): Promise<void> {
	const dir = path.dirname(configPath);

	// Ensure directory exists
	await fs.mkdir(dir, { recursive: true });

	// Race-safe file creation: exclusive `wx` flag ensures only one writer
	// creates the file; all others see EEXIST and proceed to lock.
	// This prevents the race where two first-time writers both observe ENOENT,
	// one locks+writes the real config, and the other clobbers it with `{}`.
	await raceSafeEnsureFile(configPath);

	let release: (() => Promise<void>) | undefined;
	try {
		// Acquire cross-process lock
		release = await lockfile.lock(configPath, LOCK_OPTIONS);
		logger?.debug("[ai-config] Acquired config lock for mutation");

		// Re-read current state under lock
		const current = await readCurrentConfig(configPath, logger);

		// Apply mutation
		const updated = await mutator(current);

		// Validate the result
		const result = providersConfigSchema.safeParse(updated);
		if (!result.success) {
			const errors = result.error.issues
				.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`)
				.join("; ");
			throw new Error(`[ai-config] Mutated config is invalid: ${errors}`);
		}

		// Atomic write
		await atomicWrite(configPath, result.data);

		logger?.debug("[ai-config] Config mutation written successfully");
	} finally {
		if (release) {
			await release();
			logger?.debug("[ai-config] Released config lock");
		}
	}
}

/**
 * Read and parse the current config file. Returns `{}` on missing or invalid.
 */
async function readCurrentConfig(
	configPath: string,
	logger: LoggerLike | undefined,
): Promise<ProvidersConfig> {
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		logger?.warn(`[ai-config] Failed to read ${configPath}: ${errorMessage(error)}`);
		return {};
	}

	try {
		const parsed = JSON.parse(raw);
		const result = providersConfigSchema.safeParse(parsed);
		if (!result.success) {
			logger?.warn(`[ai-config] Current config invalid, treating as empty: ${configPath}`);
			return {};
		}
		return result.data;
	} catch (error) {
		logger?.warn(`[ai-config] Failed to parse ${configPath}: ${errorMessage(error)}`);
		return {};
	}
}

/**
 * Atomic write: temp file + rename.
 */
async function atomicWrite(configPath: string, data: ProvidersConfig): Promise<void> {
	const dir = path.dirname(configPath);
	const tempPath = `${configPath}.tmp.${process.pid}`;

	await fs.mkdir(dir, { recursive: true });

	try {
		await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
			encoding: "utf-8",
			mode: 0o644,
		});
		await fs.rename(tempPath, configPath);
	} finally {
		try {
			await fs.unlink(tempPath);
		} catch {
			// Already renamed or doesn't exist
		}
	}
}

/**
 * Race-safe file creation using the exclusive `wx` flag. If the file already
 * exists, the EEXIST error is silently ignored. This prevents a TOCTOU race
 * where two concurrent callers both observe ENOENT and then one clobbers the
 * other's completed write with an empty `{}`.
 */
async function raceSafeEnsureFile(configPath: string): Promise<void> {
	const fd = await fs.open(configPath, "wx", 0o644).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return undefined; // Already exists — nothing to do
		}
		throw error;
	});
	if (fd) {
		// We created the file — write the empty config and close.
		// Wrap in try/finally so an I/O error cannot leak the descriptor.
		try {
			await fd.writeFile(JSON.stringify({}, null, 2), "utf-8");
		} finally {
			await fd.close();
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
