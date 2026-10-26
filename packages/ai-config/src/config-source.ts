/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watchable config-source contracts.
 *
 * Loader-internal machinery: the load/watch seams assemble their sources as
 * `ProviderConfigSourceProvider`s (file, env fragments, legacy Positron
 * layers). Not exported from the package entries — consumers contribute
 * config through loader options, never by injecting sources. `Disposable`
 * stays public (it is the return type of `LegacySettingsReader.watch`).
 */

import type { SourcedConfigIssue } from "./config-issue.js";
import type { ConfigLayerRef } from "./config-trace.js";
import type { ProviderConfigSource, ProviderConfigSourceKind } from "./resolve-catalog.js";
import type { ProvidersConfigFragment } from "./types.js";

/**
 * A resource that can be disposed.
 */
export interface Disposable {
	dispose(): void;
}

/** A layer as read, with the precedence role it plays. */
export interface ProviderConfigLayer extends ConfigLayerRef {
	readonly kind: ProviderConfigSourceKind;
}

/** Complete result of reading one config source at a point in time. */
export interface ProviderConfigSourceReadReport {
	/** The layer and how it read, present even when it contributes nothing. */
	readonly layer: ProviderConfigLayer;
	/** Absent when the layer currently contributes no config. */
	readonly source?: ProviderConfigSource;
	/** Current issues for this source, including an empty recovered snapshot. */
	readonly issues: SourcedConfigIssue[];
}

/** `found` when `config` sets anything a resolver reads, else `empty`. */
export function presentLayerState(config: ProvidersConfigFragment): "found" | "empty" {
	const sets = (block: object | undefined) => !!block && Object.keys(block).length > 0;
	return sets(config.providers) || sets(config.agentEngines) ? "found" : "empty";
}

/**
 * A watchable config source contributed to the source-aware catalog watch.
 *
 * `read()` produces a complete current report. Its `source` is absent when
 * the layer has nothing to contribute; issues remain present independently.
 * `watch()` subscribes to change signals; omit it for static sources (env
 * vars don't change at runtime). Any `onChange` callback triggers a debounced
 * rebuild of the whole catalog.
 */
export interface ProviderConfigSourceProvider {
	/** Read (or re-read) the current fragment for this source. */
	read(): ProviderConfigSourceReadReport | Promise<ProviderConfigSourceReadReport>;
	/** Subscribe to change signals. Returns a disposable. Optional for static sources. */
	watch?(onChange: () => void): Disposable;
}

/** The host's `hostDefaults` fragment as a static `default` source; none when the host passes none. */
export function createHostDefaultsSourceProviders(
	hostDefaults: ProvidersConfigFragment | undefined,
): ProviderConfigSourceProvider[] {
	if (!hostDefaults) return [];
	return [
		{
			read: () => ({
				layer: {
					kind: "default",
					tag: "host",
					label: "host defaults",
					detail: "set by the app",
					state: presentLayerState(hostDefaults),
				},
				source: { kind: "default", label: "host defaults", config: hostDefaults },
				issues: [],
			}),
		},
	];
}
