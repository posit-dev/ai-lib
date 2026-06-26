/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watch providers.json and emit typed change events.
 *
 * This is the **single watch seam** over the file (decisions #7/#8; review
 * suggestion: one watcher, not two). There is no separate `watchProvidersConfig`
 * raw feed — consumers use this catalog watcher and read change categories
 * (`enabled`/`connection`/`models`) off each event.
 */

import * as fs from "fs";
import * as path from "path";

import type { ResolvedProvider } from "../types";
import { buildCatalog } from "./build-catalog";
import { loadProvidersConfig } from "./load-config";
import { PROVIDERS_CONFIG_PATH } from "./paths";
import type { Disposable, LoggerLike, ProviderCatalogChange, WatchCatalogOptions } from "./types";

/**
 * Watch providers.json for changes and emit typed `ProviderCatalogChange` events.
 *
 * Uses `fs.watch` with debouncing (300ms) on the parent directory. Handles
 * non-existent paths gracefully by watching ancestor directories and chaining
 * downward as directories are created (mirrors `settingsFileWatcher.ts`).
 *
 * @param handler - Called with the change event whenever the file changes.
 * @param opts - Platform baseline, optional path/env overrides.
 * @returns Disposable that stops watching.
 */
export function watchResolvedProviderCatalog(
	handler: (change: ProviderCatalogChange) => void,
	opts: WatchCatalogOptions,
): Disposable {
	const configPath = opts.configPath ?? PROVIDERS_CONFIG_PATH;
	const logger = opts.logger;
	const filename = path.basename(configPath);
	const dir = path.dirname(configPath);

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let fileWatcher: fs.FSWatcher | undefined;
	let ancestorWatcher: fs.FSWatcher | undefined;
	let disposed = false;
	let previousCatalog: readonly ResolvedProvider[] | undefined;

	// Load initial snapshot
	void loadAndDiff();

	// ----- Debouncing -----

	const debouncedOnChange = () => {
		if (disposed) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) void loadAndDiff();
		}, 300);
	};

	// ----- File watcher -----

	const startFileWatcher = () => {
		if (disposed) return;
		try {
			fileWatcher = fs.watch(dir, (_eventType, changedFilename) => {
				if (changedFilename === filename) {
					debouncedOnChange();
				}
			});
			fileWatcher.on("error", (error) => {
				logger?.warn(`[ai-config] Watcher error: ${error.message}`);
			});
		} catch {
			logger?.debug(`[ai-config] Cannot watch ${configPath} (directory does not exist)`);
		}
	};

	// ----- Ancestor watcher (handles non-existent paths) -----

	const findNearestExistingAncestor = (targetDir: string): string => {
		let current = targetDir;
		while (!fs.existsSync(current)) {
			const parent = path.dirname(current);
			if (parent === current) return current;
			current = parent;
		}
		return current;
	};

	const startAncestorWatcher = () => {
		if (disposed) return;

		if (fs.existsSync(dir)) {
			startFileWatcher();
			return;
		}

		const watchTarget = findNearestExistingAncestor(dir);

		try {
			ancestorWatcher = fs.watch(watchTarget, (_eventType, changedName) => {
				if (disposed || !changedName) return;

				if (fs.existsSync(dir)) {
					ancestorWatcher?.close();
					ancestorWatcher = undefined;
					startFileWatcher();
					debouncedOnChange();
				} else {
					ancestorWatcher?.close();
					ancestorWatcher = undefined;
					startAncestorWatcher();
				}
			});
			ancestorWatcher.on("error", (error) => {
				logger?.warn(`[ai-config] Ancestor watcher error: ${error.message}`);
			});
		} catch {
			logger?.debug(`[ai-config] Cannot watch ancestor for ${configPath}`);
		}
	};

	// ----- Load and diff -----

	async function loadAndDiff(): Promise<void> {
		try {
			const { enforcedConfig, mergedConfig } = await loadProvidersConfig({
				configPath: opts.configPath,
				enforcedEnvVar: opts.enforcedEnvVar,
				logger: opts.logger,
			});

			const newCatalog = buildCatalog(mergedConfig, enforcedConfig?.providers, opts.baseline);

			const change = diffCatalogs(previousCatalog, newCatalog);
			previousCatalog = newCatalog;

			// Only fire on actual changes (skip initial load if previousCatalog was undefined)
			if (change) {
				handler(change);
			}
		} catch (error) {
			logger?.warn(
				`[ai-config] Failed to reload provider catalog: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Start watching
	startAncestorWatcher();

	return {
		dispose: () => {
			disposed = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			fileWatcher?.close();
			ancestorWatcher?.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Diff two catalogs and return change flags. Returns `undefined` if the
 * previous catalog is unknown (initial load — no diff possible).
 */
function diffCatalogs(
	previous: readonly ResolvedProvider[] | undefined,
	current: readonly ResolvedProvider[],
): ProviderCatalogChange | undefined {
	if (!previous) {
		// Initial load — no previous to diff against
		return undefined;
	}

	let enabledChanged = false;
	let connectionChanged = false;
	let modelsChanged = false;

	// Build lookup by id
	const prevById = new Map(previous.map((p) => [p.id as string, p]));
	const currById = new Map(current.map((p) => [p.id as string, p]));

	// Check for changes and additions
	for (const [id, curr] of currById) {
		const prev = prevById.get(id);
		if (!prev) {
			// New provider — everything changed
			enabledChanged = true;
			connectionChanged = true;
			modelsChanged = true;
			break;
		}

		if (prev.enabled !== curr.enabled) {
			enabledChanged = true;
		}
		if (!shallowConnectionEqual(prev.connection, curr.connection)) {
			connectionChanged = true;
		}
		if (!jsonEqual(prev.models, curr.models)) {
			modelsChanged = true;
		}
	}

	// Check for removals
	if (!enabledChanged) {
		for (const id of prevById.keys()) {
			if (!currById.has(id)) {
				enabledChanged = true;
				connectionChanged = true;
				modelsChanged = true;
				break;
			}
		}
	}

	// If nothing changed, don't fire
	if (!enabledChanged && !connectionChanged && !modelsChanged) {
		return undefined;
	}

	return {
		catalog: current,
		enabledChanged,
		connectionChanged,
		modelsChanged,
	};
}

/**
 * Shallow equality check for connection config.
 */
function shallowConnectionEqual(
	a: ResolvedProvider["connection"],
	b: ResolvedProvider["connection"],
): boolean {
	return jsonEqual(a, b);
}

/**
 * JSON-based deep equality. Good enough for small config objects.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
