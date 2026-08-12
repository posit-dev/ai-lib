/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "node:fs";

import { mintCustomProviderId, type CustomProviderEntry } from "../types.js";
import { parseProvidersConfig } from "./parse-providers-config.js";
import { PROVIDERS_CONFIG_PATH } from "./paths.js";

export interface ReadUserCustomProviderEntryOptions {
	/** Override the user providers.json path. */
	readonly configPath?: string;
}

/** Raised when a caller asks the custom-entry reader for a non-custom provider id. */
export class NonCustomProviderIdError extends Error {
	readonly providerId: string;

	constructor(providerId: string, options?: ErrorOptions) {
		super(`[ai-config] Provider id "${providerId}" is not a valid custom provider id.`, options);
		this.name = "NonCustomProviderIdError";
		this.providerId = providerId;
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

	const configPath = options.configPath ?? PROVIDERS_CONFIG_PATH;
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if (isMissingFile(error)) {
			return undefined;
		}
		throw new Error(
			`[ai-config] Cannot read ${configPath}: ${errorMessage(error)}. Fix the file before editing custom providers.`,
			{ cause: error },
		);
	}

	try {
		const customProviders = parseProvidersConfig(raw).providers?.custom;
		if (!customProviders || !Object.prototype.hasOwnProperty.call(customProviders, providerId)) {
			return undefined;
		}
		return customProviders[providerId];
	} catch (error) {
		throw new Error(
			`[ai-config] Cannot read ${configPath}: ${errorMessage(error)}. Fix the file before editing custom providers.`,
			{ cause: error },
		);
	}
}
