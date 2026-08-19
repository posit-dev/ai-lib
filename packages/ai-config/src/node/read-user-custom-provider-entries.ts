/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "node:fs";

import type { CustomProviderEntry } from "../types.js";
import { parseProvidersConfig } from "./parse-providers-config.js";
import { PROVIDERS_CONFIG_PATH } from "./paths.js";

export interface ReadUserCustomProviderEntriesOptions {
	/** Override the user providers.json path. */
	readonly configPath?: string;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Read every custom provider entry exactly as authored in the user
 * providers.json, in a single strict parse.
 *
 * Batch companion to `readUserCustomProviderEntry` for consumers that need
 * ownership of every custom entry at once — e.g. projecting per-provider
 * management capabilities from one snapshot, where one parse cannot tear
 * against a mid-build providers.json write. The same strictness applies: a
 * missing file is the normal externally-managed outcome (an empty map), while
 * malformed or unreadable content is never salvaged to an empty
 * configuration.
 */
export async function readUserCustomProviderEntries(
	options: ReadUserCustomProviderEntriesOptions = {},
): Promise<ReadonlyMap<string, CustomProviderEntry>> {
	const configPath = options.configPath ?? PROVIDERS_CONFIG_PATH;
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf-8");
	} catch (error) {
		if (isMissingFile(error)) {
			return new Map();
		}
		throw new Error(
			`[ai-config] Cannot read ${configPath}: ${errorMessage(error)}. Fix the file before editing custom providers.`,
			{ cause: error },
		);
	}

	try {
		const customProviders = parseProvidersConfig(raw).providers?.custom ?? {};
		return new Map(Object.entries(customProviders));
	} catch (error) {
		throw new Error(
			`[ai-config] Cannot read ${configPath}: ${errorMessage(error)}. Fix the file before editing custom providers.`,
			{ cause: error },
		);
	}
}
