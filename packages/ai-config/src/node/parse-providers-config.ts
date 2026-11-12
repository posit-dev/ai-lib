/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Shared parse-and-validate seam for the user-editable providers.json file. */

import { salvageProvidersConfig } from "../salvage-config.js";
import type { SalvagedProvidersConfig } from "../salvage-config.js";
import { providersConfigSchema } from "../schema.js";
import type { ProvidersConfig } from "../types.js";
import { parseJsonc } from "./parse-jsonc.js";

/**
 * Whether providers.json text is empty or whitespace only. Such a file holds
 * no configuration, so it parses as `{}` rather than as invalid JSONC: another
 * process sees exactly this while a first mutation is between creating the
 * file and seeding it, and a writer stopped there leaves it behind for good.
 * A file holding only comments is still invalid, since only a user writes
 * comments.
 */
export function isBlankConfigText(text: string): boolean {
	return text.trim() === "";
}

/**
 * Parse providers.json as JSONC and validate its complete on-disk shape. Blank
 * text is `{}`.
 *
 * Syntax failures propagate as `SyntaxError`; schema failures propagate as a
 * Zod error. Loaders can therefore report and degrade by failure kind, while
 * mutations can abort without duplicating either policy.
 */
export function parseProvidersConfig(text: string): ProvidersConfig {
	return isBlankConfigText(text) ? {} : providersConfigSchema.parse(parseJsonc(text));
}

/**
 * Parse JSONC syntax, then salvage independently valid provider blocks. Blank
 * text is `{}`, with no issues.
 */
export function parseProvidersConfigTolerant(text: string): SalvagedProvidersConfig {
	return isBlankConfigText(text)
		? { config: {}, issues: [] }
		: salvageProvidersConfig(parseJsonc(text));
}
