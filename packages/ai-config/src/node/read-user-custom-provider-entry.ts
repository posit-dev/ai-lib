/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId, type CustomProviderEntry } from "../types.js";
import {
	readUserCustomProviderEntries,
	type ReadUserCustomProviderEntriesOptions,
} from "./read-user-custom-provider-entries.js";

/** Raised when a caller asks the custom-entry reader for a non-custom provider id. */
export class NonCustomProviderIdError extends Error {
	readonly providerId: string;

	constructor(providerId: string, options?: ErrorOptions) {
		super(`[ai-config] Provider id "${providerId}" is not a valid custom provider id.`, options);
		this.name = "NonCustomProviderIdError";
		this.providerId = providerId;
	}
}

export interface ReadUserCustomProviderEntryOptions
	extends ReadUserCustomProviderEntriesOptions {}

/**
 * Read one custom provider exactly as authored in the user providers.json.
 *
 * This intentionally bypasses source overlays and catalog derivation. A missing
 * file or entry is the normal externally-managed outcome. A present file is
 * parsed with the same full, strict schema used by mutations; malformed or
 * unreadable content is never salvaged to an empty configuration.
 */
export async function readUserCustomProviderEntry(
	providerId: string,
	options: ReadUserCustomProviderEntryOptions = {},
): Promise<CustomProviderEntry | undefined> {
	try {
		mintCustomProviderId(providerId);
	} catch (error) {
		throw new NonCustomProviderIdError(providerId, { cause: error });
	}

	const entries = await readUserCustomProviderEntries(options);
	return entries.get(providerId);
}
