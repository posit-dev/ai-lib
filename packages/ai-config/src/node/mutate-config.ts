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
import { createRequire } from "module";
import * as path from "path";
import { isDeepStrictEqual } from "util";

import lockfile from "proper-lockfile";

import { editJsonc, normalizeJsonValue, PROVIDERS_CONFIG_VERSION } from "../index.js";
import { providersConfigSchema } from "../schema.js";
import type { ProvidersConfig } from "../types.js";
import { parseProvidersConfig } from "./parse-providers-config.js";
import { PROVIDERS_CONFIG_PATH } from "./paths.js";
import type { LoggerLike, MutateConfigOptions } from "./types.js";

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
 * config to write. A same-object or value-identical result performs no write.
 * Existing JSONC comments and formatting outside changed paths are preserved.
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
	const fileCreated = await raceSafeEnsureFile(configPath, logger);

	let release: (() => Promise<void>) | undefined;
	try {
		// Acquire cross-process lock
		release = await lockfile.lock(configPath, LOCK_OPTIONS);
		logger?.debug("[ai-config] Acquired config lock for mutation");

		// Re-read current state under lock
		const { raw, config: current } = await readCurrentConfig(configPath);

		// Apply mutation
		let updated = await mutator(current);

		// If we just created the file, inject seed metadata ($schema, version)
		// into the first mutation result so mutators don't need to preserve them.
		// This is seed-only — subsequent mutations pass through whatever the
		// user/mutator wrote. If a user later removes $schema, that's their choice.
		if (fileCreated && updated.$schema === undefined) {
			updated = { $schema: "./providers.schema.json", ...updated };
		}
		if (fileCreated && updated.version === undefined) {
			updated = { ...updated, version: PROVIDERS_CONFIG_VERSION };
		}

		// Validate the result
		const result = providersConfigSchema.safeParse(updated);
		if (!result.success) {
			const errors = result.error.issues
				.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`)
				.join("; ");
			throw new Error(`[ai-config] Mutated config is invalid: ${errors}`);
		}

		const normalized = normalizeJsonValue(result.data);
		const output = fileCreated ? JSON.stringify(normalized, null, 2) : editJsonc(raw, result.data);

		if (output === raw) {
			logger?.debug("[ai-config] Config mutation made no changes");
			return;
		}

		// Reparse and revalidate the exact bytes that will be persisted. Compare
		// against the same round-trip-normalized value used by the editor.
		const reparsed = parseProvidersConfig(output);
		if (!isDeepStrictEqual(normalizeJsonValue(reparsed), normalized)) {
			throw new Error("[ai-config] Edited config does not match the validated mutation result");
		}

		// Atomic write
		await atomicWrite(configPath, output);

		logger?.debug("[ai-config] Config mutation written successfully");
	} finally {
		if (release) {
			await release();
			logger?.debug("[ai-config] Released config lock");
		}
	}
}

/**
 * Read and validate the current config file. Any failure aborts the mutation:
 * after race-safe creation, an unreadable or missing file is anomalous, and
 * treating invalid content as `{}` would silently discard user configuration.
 */
async function readCurrentConfig(
	configPath: string,
): Promise<{ raw: string; config: ProvidersConfig }> {
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		return { raw, config: parseProvidersConfig(raw) };
	} catch (error) {
		throw new Error(
			`[ai-config] Cannot mutate ${configPath}: ${errorMessage(error)}. Mutation aborted until the file is fixed.`,
			{ cause: error },
		);
	}
}

/**
 * Atomic write: temp file + rename.
 */
async function atomicWrite(configPath: string, text: string): Promise<void> {
	const dir = path.dirname(configPath);
	const tempPath = `${configPath}.tmp.${process.pid}`;

	await fs.mkdir(dir, { recursive: true });

	try {
		await fs.writeFile(tempPath, text, {
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
 *
 * On file creation, seeds the file with `$schema` and `version` fields, and
 * best-effort copies `providers.schema.json` alongside the config file for
 * editor validation/autocomplete.
 *
 * @returns `true` if this call created the file (first write), `false` if
 * it already existed. The caller uses this to inject seed metadata into
 * the first mutation result.
 */
async function raceSafeEnsureFile(
	configPath: string,
	logger: LoggerLike | undefined,
): Promise<boolean> {
	const fd = await fs.open(configPath, "wx", 0o644).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return undefined; // Already exists — nothing to do
		}
		throw error;
	});
	if (fd) {
		// We created the file — write the seeded config and close.
		// Wrap in try/finally so an I/O error cannot leak the descriptor.
		const seed = {
			$schema: "./providers.schema.json",
			version: PROVIDERS_CONFIG_VERSION,
		};
		try {
			await fd.writeFile(JSON.stringify(seed, null, 2), "utf-8");
		} finally {
			await fd.close();
		}

		// Best-effort: copy providers.schema.json alongside the config file.
		// This enables editor validation/autocomplete. If it fails (missing
		// file, permissions), log but don't fail — the schema hint is a
		// nice-to-have, not a correctness requirement.
		await copySchemaFile(configPath, logger);
		return true;
	}
	return false;
}

/**
 * Best-effort copy of providers.schema.json from the ai-config package into
 * the same directory as the config file. Uses the package export to resolve
 * the source path.
 */
async function copySchemaFile(configPath: string, logger: LoggerLike | undefined): Promise<void> {
	try {
		// Resolve the schema file from the package export
		const require = createRequire(import.meta.url);
		const schemaSource = require.resolve("ai-config/providers.schema.json");
		const schemaTarget = path.join(path.dirname(configPath), "providers.schema.json");
		await fs.copyFile(schemaSource, schemaTarget);
		logger?.debug("[ai-config] Copied providers.schema.json to config directory");
	} catch (error) {
		logger?.warn(`[ai-config] Could not copy providers.schema.json: ${errorMessage(error)}`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
