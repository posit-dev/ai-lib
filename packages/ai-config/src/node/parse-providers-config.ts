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
 * Parse providers.json as JSONC and validate its complete on-disk shape.
 *
 * Syntax failures propagate as `SyntaxError`; schema failures propagate as a
 * Zod error. Loaders can therefore report and degrade by failure kind, while
 * mutations can abort without duplicating either policy.
 */
export function parseProvidersConfig(text: string): ProvidersConfig {
	return providersConfigSchema.parse(parseJsonc(text));
}

/** Parse JSONC syntax, then salvage independently valid provider blocks. */
export function parseProvidersConfigTolerant(text: string): SalvagedProvidersConfig {
	return salvageProvidersConfig(parseJsonc(text));
}
