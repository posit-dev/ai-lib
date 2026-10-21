/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provenance shapes for explaining resolved provider config: which layers
 * were read, what each said about a key, and which one decided it. Hosts
 * render these as a settings report; every value is already masked (see
 * `providers-config-safe-fields.ts`).
 */

import type { SourcedConfigIssue } from "./config-issue.js";

/**
 * How a layer read: `missing` (the file does not exist), `empty` (it exists
 * but sets nothing), `invalid` (it could not be used at all; the issue says
 * why), `not set` (an env var or setting that is absent).
 */
export type ConfigLayerState = "found" | "empty" | "missing" | "invalid" | "not set";

/** One config layer, listed even when it contributes nothing. */
export interface ConfigLayerRef {
	/** Short word naming the layer in traces, e.g. `enforced`, `user`. */
	readonly tag: string;
	/** What the layer is, e.g. "user providers.json". */
	readonly label: string;
	/** Where it comes from: a file path or env var name(s). */
	readonly detail: string;
	readonly state: ConfigLayerState;
}

/** What one layer said about a key. */
export interface ConfigLayerValue {
	/** A {@link ConfigLayerRef.tag}, or an env var's name such as `$OPENAI_BASE_URL`. */
	readonly layer: string;
	/** Already masked. */
	readonly value: unknown;
	/**
	 * `effective`: this value is used. `overridden`: a higher layer's value
	 * is used. `no-effect`: an admin-enforced value is used. `dropped`: the
	 * value was removed (its source was ignored, or a higher layer replaced
	 * the setting it belongs to) and nothing replaced it here.
	 */
	readonly status: "effective" | "overridden" | "no-effect" | "dropped";
}

/** How one key got its value. */
export interface ConfigValueTrace {
	/** Key path from the config root. */
	readonly path: readonly string[];
	/** The value in use, masked; undefined when no layer's value survives. */
	readonly effective: unknown;
	readonly rule: "highest-wins";
	/** e.g. "lists replace, never merge", "replaces whole object". */
	readonly note?: string;
	/** Every layer that sets the key, highest precedence first. */
	readonly layers: readonly ConfigLayerValue[];
}

/** The provider config explained from its current sources. */
export interface ProviderCatalogExplanation {
	/** Every layer read, highest precedence first, including the connection env vars. */
	readonly layers: readonly ConfigLayerRef[];
	/** One trace per key some layer sets. */
	readonly entries: readonly ConfigValueTrace[];
	/** Read and resolve issues, in fixed wording. */
	readonly issues: readonly SourcedConfigIssue[];
}
