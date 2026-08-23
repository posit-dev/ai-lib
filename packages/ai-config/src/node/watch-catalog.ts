/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watch the provider config sources and emit typed change events.
 *
 * This is the **single, source-aware watch seam**. It watches the built-in
 * sources (the `providers.json` file + the enforced/default env fragments)
 * and the legacy Positron settings layers the loader opted into (the
 * `legacyPositronSettings` reader and/or the `legacyPositronEnforcedSettings`
 * flag). Any source change — file edit, legacy settings change, etc. —
 * triggers a debounced rebuild of the whole catalog and complete issue
 * snapshot. Consumers receive both snapshots and typed change categories
 * (`enabled`/`connection`/`models`/`issues`) on each emitted event.
 */

import * as fs from "fs";
import * as path from "path";

import { formatConfigIssue } from "../config-issue.js";
import type { SourcedConfigIssue } from "../config-issue.js";
import type {
	ProviderConfigSourceProvider,
	ProviderConfigSourceReadReport,
} from "../config-source.js";
import { createLegacyPositronSourceProviders } from "../legacy-positron-settings/sources.js";
import { resolveProviderCatalogReport } from "../resolve-catalog.js";
import type { LoggerLike, ResolvedProvider } from "../types.js";
import { readEnvFragment, readFileConfig } from "./load-config.js";
import { DEFAULT_ENV_VAR, ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths.js";
import type {
	Disposable,
	ProviderCatalogChange,
	WatchCatalogHandle,
	WatchCatalogOptions,
} from "./types.js";

/**
 * Watch the provider config sources for changes and emit typed
 * `ProviderCatalogChange` events.
 *
 * The file source uses `fs.watch` with debouncing (300ms) on the parent
 * directory and handles non-existent paths gracefully by watching ancestor
 * directories and chaining downward as directories are created (mirrors
 * `settingsFileWatcher.ts`). Env sources are static (read once per rebuild).
 *
 * @param handler - Called with the change event whenever any source changes.
 * @param opts - Optional path/env overrides and the optional legacy opt-ins
 *   (`legacyPositronSettings` reader, `legacyPositronEnforcedSettings` flag).
 * @returns Watch handle whose readiness promise settles after the initial
 * snapshot is loaded and whose disposable remains backward compatible.
 */
export function watchResolvedProviderCatalog(
	handler: (change: ProviderCatalogChange) => void,
	opts: WatchCatalogOptions,
): WatchCatalogHandle {
	const configPath = opts.configPath ?? PROVIDERS_CONFIG_PATH;
	const env = opts.envVars ?? process.env;
	const logger = opts.logger;

	// Assemble the watchable sources: file (watchable) + env fragments
	// (static) + the legacy Positron layers the loader opted into.
	const sourceProviders: ProviderConfigSourceProvider[] = [
		createFileSourceProvider(configPath, logger),
		createEnvSourceProvider("enforced", opts.enforcedEnvVar ?? ENFORCED_ENV_VAR, env),
		createEnvSourceProvider("default", opts.defaultEnvVar ?? DEFAULT_ENV_VAR, env),
		// PROVIDER-SETTINGS-MIGRATION(legacy-positron)
		...createLegacyPositronSourceProviders(opts, env),
	];

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let previousCatalog: readonly ResolvedProvider[] | undefined;
	let previousIssues: readonly SourcedConfigIssue[] | undefined;
	const subscriptions: Disposable[] = [];

	// ----- Load and diff -----

	async function rebuild(): Promise<void> {
		if (disposed) return;
		try {
			const reports = await Promise.all(sourceProviders.map((provider) => provider.read()));
			const sources = reports.flatMap((report) => (report.source ? [report.source] : []));

			const resolver = resolveProviderCatalogReport({
				sources,
				// Node seam: inject the resolved env (process.env by default) so
				// the pure resolver stays free of Node globals.
				envVars: env,
			});
			const newCatalog = resolver.catalog;
			const newIssues = [...reports.flatMap((report) => report.issues), ...resolver.issues];

			for (const issue of addedIssues(previousIssues, newIssues)) {
				logger?.warn(formatConfigIssue(issue));
			}

			const change = diffCatalogs(previousCatalog, newCatalog, previousIssues, newIssues);
			previousCatalog = newCatalog;
			previousIssues = newIssues;

			// Only fire on actual changes (skip initial load).
			if (change) {
				handler(change);
			}
		} catch (error) {
			logger?.warn(
				`[ai-config] Failed to reload provider catalog: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const debouncedRebuild = () => {
		if (disposed) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			if (!disposed) void rebuild();
		}, 300);
	};

	// Load initial snapshot and expose its completion so callers can perform
	// subsequent writes without racing initialization.
	const ready = rebuild();

	// Subscribe to change signals from every watchable source.
	for (const provider of sourceProviders) {
		if (provider.watch) {
			subscriptions.push(provider.watch(debouncedRebuild));
		}
	}

	return {
		ready,
		dispose: () => {
			disposed = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			for (const sub of subscriptions) {
				sub.dispose();
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Built-in source providers
// ---------------------------------------------------------------------------

/**
 * The `providers.json` file as a watchable `user` source. Encapsulates the
 * `fs.watch` + ancestor-chaining logic so the catalog watcher only sees a
 * `read()` + `watch(onChange)` pair.
 */
function createFileSourceProvider(
	configPath: string,
	logger: LoggerLike | undefined,
): ProviderConfigSourceProvider {
	const filename = path.basename(configPath);
	const dir = path.dirname(configPath);

	return {
		async read(): Promise<ProviderConfigSourceReadReport> {
			return readFileConfig(configPath);
		},

		watch(onChange: () => void): Disposable {
			let fileWatcher: fs.FSWatcher | undefined;
			let ancestorWatcher: fs.FSWatcher | undefined;
			let watchDisposed = false;

			const startFileWatcher = () => {
				if (watchDisposed) return;
				try {
					fileWatcher = fs.watch(dir, (_eventType, changedFilename) => {
						if (changedFilename === filename) {
							onChange();
						}
					});
					fileWatcher.on("error", (error) => {
						logger?.warn(`[ai-config] Watcher error: ${error.message}`);
					});
				} catch {
					logger?.debug(`[ai-config] Cannot watch ${configPath} (directory does not exist)`);
				}
			};

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
				if (watchDisposed) return;

				if (fs.existsSync(dir)) {
					startFileWatcher();
					return;
				}

				const watchTarget = findNearestExistingAncestor(dir);

				try {
					ancestorWatcher = fs.watch(watchTarget, (_eventType, changedName) => {
						if (watchDisposed || !changedName) return;

						if (fs.existsSync(dir)) {
							ancestorWatcher?.close();
							ancestorWatcher = undefined;
							startFileWatcher();
							onChange();
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

			startAncestorWatcher();

			return {
				dispose: () => {
					watchDisposed = true;
					fileWatcher?.close();
					ancestorWatcher?.close();
				},
			};
		},
	};
}

/**
 * An env fragment (`enforced` or `default`) as a static source. Env vars do
 * not change within a process, so there is no `watch()` — the value is read
 * fresh on each rebuild triggered by another source.
 */
function createEnvSourceProvider(
	kind: "enforced" | "default",
	envVarName: string,
	env: Record<string, string | undefined>,
): ProviderConfigSourceProvider {
	return {
		read(): ProviderConfigSourceReadReport {
			return readEnvFragment(kind, envVarName, env);
		},
	};
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/**
 * Compact comparison record for a single provider entry.
 * Grouping the four fields into one record lets us diff additions, removals,
 * and per-field changes in a single pass with no special-case branches.
 */
interface ProviderSignature {
	enabled: boolean;
	clientKind: string;
	connection: string; // JSON-serialized for comparison
	connectionProvenance: string; // JSON-serialized for comparison
	models: string; // JSON-serialized for comparison
}

function toSignature(p: ResolvedProvider): ProviderSignature {
	return {
		enabled: p.enabled,
		clientKind: p.clientKind,
		connection: JSON.stringify(p.connection),
		connectionProvenance: JSON.stringify(p.connectionProvenance),
		models: JSON.stringify(p.models),
	};
}

/**
 * Diff two catalogs and return change flags. Returns `undefined` if the
 * previous catalog is unknown (initial load — no diff possible).
 */
function diffCatalogs(
	previous: readonly ResolvedProvider[] | undefined,
	current: readonly ResolvedProvider[],
	previousIssues: readonly SourcedConfigIssue[] | undefined,
	currentIssues: readonly SourcedConfigIssue[],
): ProviderCatalogChange | undefined {
	if (!previous) {
		// Initial load — no previous to diff against
		return undefined;
	}

	let enabledChanged = false;
	let connectionChanged = false;
	let modelsChanged = false;
	const issuesChanged = !issueSetsEqual(previousIssues ?? [], currentIssues);

	// Build signature lookups by id
	const prevById = new Map(previous.map((p) => [p.id as string, toSignature(p)]));
	const currById = new Map(current.map((p) => [p.id as string, toSignature(p)]));

	// Collect all provider ids from both catalogs
	const allIds = new Set([...prevById.keys(), ...currById.keys()]);

	for (const id of allIds) {
		const prev = prevById.get(id);
		const curr = currById.get(id);

		if (!prev || !curr) {
			// Provider added or removed — all categories change
			enabledChanged = true;
			connectionChanged = true;
			modelsChanged = true;
			continue;
		}

		// Compare each field group
		if (prev.enabled !== curr.enabled) {
			enabledChanged = true;
		}
		if (
			prev.clientKind !== curr.clientKind ||
			prev.connection !== curr.connection ||
			prev.connectionProvenance !== curr.connectionProvenance
		) {
			connectionChanged = true;
		}
		if (prev.models !== curr.models) {
			modelsChanged = true;
		}
	}

	// If nothing changed, don't fire
	if (!enabledChanged && !connectionChanged && !modelsChanged && !issuesChanged) {
		return undefined;
	}

	return {
		catalog: current,
		issues: currentIssues,
		enabledChanged,
		connectionChanged,
		modelsChanged,
		issuesChanged,
	};
}

function issueKey(issue: SourcedConfigIssue): string {
	return JSON.stringify({
		source: issue.source,
		path: issue.path,
		severity: issue.severity,
		message: issue.message,
	});
}

function issueSetsEqual(
	left: readonly SourcedConfigIssue[],
	right: readonly SourcedConfigIssue[],
): boolean {
	if (left.length !== right.length) return false;
	const leftKeys = left.map(issueKey).sort();
	const rightKeys = right.map(issueKey).sort();
	return leftKeys.every((key, index) => key === rightKeys[index]);
}

function addedIssues(
	previous: readonly SourcedConfigIssue[] | undefined,
	current: readonly SourcedConfigIssue[],
): readonly SourcedConfigIssue[] {
	const previousKeys = new Set((previous ?? []).map(issueKey));
	return current.filter((issue) => !previousKeys.has(issueKey(issue)));
}
