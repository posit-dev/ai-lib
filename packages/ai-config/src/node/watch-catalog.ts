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
 * snapshot. Consumers receive the snapshots (catalog, `agentEngines` and its
 * enablement provenance, issues) and typed change categories
 * (`enabled`/`connection`/`models`/`issues`/`agentEngines`) on each emitted
 * event.
 */

import * as fs from "fs";
import * as path from "path";

import { formatConfigIssue } from "../config-issue.js";
import type { SourcedConfigIssue } from "../config-issue.js";
import { createHostDefaultsSourceProviders } from "../config-source.js";
import type {
	ProviderConfigSourceProvider,
	ProviderConfigSourceReadReport,
} from "../config-source.js";
import { createLegacyPositronSourceProviders } from "../legacy-positron-settings/sources.js";
import { resolveProviderCatalogReport } from "../resolve-catalog.js";
import type {
	AgentEnginesConfig,
	LoggerLike,
	ResolvedAgentEnginesProvenance,
	ResolvedProvider,
} from "../types.js";
import { readEnvFragment, readFileConfig } from "./load-config.js";
import { DEFAULT_ENV_VAR, ENFORCED_ENV_VAR, PROVIDERS_CONFIG_PATH } from "./paths.js";
import type {
	Disposable,
	ProviderCatalogChange,
	ProviderCatalogEntryDiff,
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
 * @param opts - Required environment, optional path overrides and legacy opt-ins
 *   (`legacyPositronSettings` reader, `legacyPositronEnforcedSettings` flag).
 * @returns Watch handle whose readiness promise settles after the initial
 * snapshot is loaded and whose disposable remains backward compatible.
 */
export function watchResolvedProviderCatalog(
	handler: (change: ProviderCatalogChange) => void,
	opts: WatchCatalogOptions,
): WatchCatalogHandle {
	const configPath = opts.configPath ?? PROVIDERS_CONFIG_PATH;
	const env = opts.envVars;
	const logger = opts.logger;

	// Assemble the watchable sources: file (watchable) + env fragments
	// (static) + the legacy Positron layers the loader opted into.
	const sourceProviders: ProviderConfigSourceProvider[] = [
		createFileSourceProvider(configPath, logger),
		createEnvSourceProvider("enforced", opts.enforcedEnvVar ?? ENFORCED_ENV_VAR, env),
		createEnvSourceProvider("default", opts.defaultEnvVar ?? DEFAULT_ENV_VAR, env),
		// PROVIDER-SETTINGS-MIGRATION(legacy-positron)
		...createLegacyPositronSourceProviders(opts, env),
		...createHostDefaultsSourceProviders(opts.hostDefaults),
	];

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let previous: CatalogSnapshot | undefined;
	const subscriptions: Disposable[] = [];

	// ----- Load and diff -----

	async function rebuild(): Promise<void> {
		if (disposed) return;
		try {
			const reports = await Promise.all(sourceProviders.map((provider) => provider.read()));
			const sources = reports.flatMap((report) => (report.source ? [report.source] : []));

			const resolver = resolveProviderCatalogReport({
				sources,
				// The pure resolver cannot read Node globals.
				envVars: env,
			});
			const current: CatalogSnapshot = {
				catalog: resolver.catalog,
				agentEngines: resolver.agentEngines,
				agentEnginesProvenance: resolver.agentEnginesProvenance,
				issues: [...reports.flatMap((report) => report.issues), ...resolver.issues],
			};

			for (const issue of addedIssues(previous?.issues, current.issues)) {
				logger?.warn(formatConfigIssue(issue));
			}

			const change = diffSnapshots(previous, current);
			previous = current;

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
	authPolicy: string; // JSON-serialized for comparison
	opencodeProduct: string; // JSON-serialized for comparison
	models: string; // JSON-serialized for comparison
}

function toSignature(p: ResolvedProvider): ProviderSignature {
	return {
		enabled: p.enabled,
		clientKind: p.clientKind,
		connection: JSON.stringify(p.connection),
		connectionProvenance: JSON.stringify(p.connectionProvenance),
		authPolicy: JSON.stringify(p.authPolicy),
		// The effective-product projection is value-bearing: a product-only
		// edit beneath a fixed baseUrl changes no connection field, so without
		// it live hosts would show a stale selector until restart.
		opencodeProduct: JSON.stringify(p.opencodeProduct),
		models: JSON.stringify(p.models),
	};
}

/**
 * Classify, per provider ID, how `current` differs from `previous`.
 *
 * This is the single source of truth for catalog change classification: the
 * watcher's aggregate flags are derived from it, and hosts that install
 * catalogs themselves use it to scope their own effects. Unchanged providers
 * are omitted, so an empty result means the catalogs are equivalent.
 *
 * An added or removed provider is reported with every category set. An
 * auth-policy-only change (e.g. toggling a custom entry's `apiKeyOptional`)
 * is activation-relevant — credentials must be re-synthesized — so it lands
 * in the connection category, as do client-kind, provenance, and
 * effective-product changes.
 *
 * Result order is stable: providers in `previous` order, then providers only
 * in `current`.
 */
export function diffProviderCatalogs(
	previous: readonly ResolvedProvider[],
	current: readonly ResolvedProvider[],
): readonly ProviderCatalogEntryDiff[] {
	const prevById = new Map(previous.map((p) => [p.id, toSignature(p)]));
	const currById = new Map(current.map((p) => [p.id, toSignature(p)]));
	const allIds = new Set([...prevById.keys(), ...currById.keys()]);
	const diffs: ProviderCatalogEntryDiff[] = [];

	for (const id of allIds) {
		const prev = prevById.get(id);
		const curr = currById.get(id);

		if (!prev || !curr) {
			diffs.push({
				id,
				change: prev ? "removed" : "added",
				enabled: true,
				connection: true,
				models: true,
			});
			continue;
		}

		const enabled = prev.enabled !== curr.enabled;
		const connection =
			prev.clientKind !== curr.clientKind ||
			prev.connection !== curr.connection ||
			prev.connectionProvenance !== curr.connectionProvenance ||
			prev.authPolicy !== curr.authPolicy ||
			prev.opencodeProduct !== curr.opencodeProduct;
		const models = prev.models !== curr.models;
		if (enabled || connection || models) {
			diffs.push({ id, change: "updated", enabled, connection, models });
		}
	}

	return diffs;
}

/** One rebuild's resolved state, diffed against the previous rebuild's. */
interface CatalogSnapshot {
	readonly catalog: readonly ResolvedProvider[];
	readonly agentEngines: AgentEnginesConfig;
	readonly agentEnginesProvenance: ResolvedAgentEnginesProvenance;
	readonly issues: readonly SourcedConfigIssue[];
}

/**
 * Diff two snapshots and return change flags. Returns `undefined` if the
 * previous snapshot is unknown (initial load — no diff possible) or nothing
 * changed.
 */
function diffSnapshots(
	previous: CatalogSnapshot | undefined,
	current: CatalogSnapshot,
): ProviderCatalogChange | undefined {
	if (!previous) {
		// Initial load — no previous to diff against
		return undefined;
	}

	const diffs = diffProviderCatalogs(previous.catalog, current.catalog);
	const issuesChanged = !issueSetsEqual(previous.issues, current.issues);
	// Same sources yield the same key order, so serialized equality is exact.
	// A provenance-only change counts, as per-provider provenance does above.
	const agentEnginesChanged =
		JSON.stringify(previous.agentEngines) !== JSON.stringify(current.agentEngines) ||
		JSON.stringify(previous.agentEnginesProvenance) !==
			JSON.stringify(current.agentEnginesProvenance);

	// If nothing changed, don't fire
	if (diffs.length === 0 && !issuesChanged && !agentEnginesChanged) {
		return undefined;
	}

	return {
		catalog: current.catalog,
		issues: current.issues,
		agentEngines: current.agentEngines,
		agentEnginesProvenance: current.agentEnginesProvenance,
		agentEnginesChanged,
		enabledChanged: diffs.some((d) => d.enabled),
		connectionChanged: diffs.some((d) => d.connection),
		modelsChanged: diffs.some((d) => d.models),
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
