/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Watchable config-source contracts.
 *
 * These live in the PURE entry (no filesystem, no `process`, no `vscode`) so
 * host packages that build their own sources — e.g. `ai-config/positron`,
 * whose `createPositronConfigSource()` returns a `ProviderConfigSourceProvider`
 * — can reference the seam types via the root entry without pulling in the node
 * (`fs`) entry. The node entry re-exports both for back-compat.
 */

import type { ProviderConfigSource } from "./resolve-catalog";

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
