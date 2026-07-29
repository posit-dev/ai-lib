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

import type { ProviderConfigSource } from "./resolve-catalog.js";

/**
 * A resource that can be disposed.
 */
export interface Disposable {
	dispose(): void;
}

/**
 * A watchable config source contributed to the source-aware catalog watch.
 *
 * `read()` produces the source's current fragment (or `undefined` when the
 * source has nothing to contribute — e.g. an unset env var or missing file).
 * `watch()` subscribes to change signals; omit it for static sources (env
 * vars don't change at runtime). Any `onChange` callback triggers a debounced
 * rebuild of the whole catalog.
 */
export interface ProviderConfigSourceProvider {
	/** Read (or re-read) the current fragment for this source. */
	read(): ProviderConfigSource | undefined | Promise<ProviderConfigSource | undefined>;
	/** Subscribe to change signals. Returns a disposable. Optional for static sources. */
	watch?(onChange: () => void): Disposable;
}
