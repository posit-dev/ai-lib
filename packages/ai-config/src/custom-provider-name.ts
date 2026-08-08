/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isBuiltinProviderId, RESERVED_PROVIDER_KEYS } from "./vocabulary.js";

/** Shared custom-provider name policy for strict parsing, salvage, and branded ids. */
export function customProviderNameIssues(name: string): readonly string[] {
	const issues: string[] = [];
	if (isBuiltinProviderId(name)) {
		issues.push(`Custom provider name "${name}" collides with a built-in provider id.`);
	}
	if ((RESERVED_PROVIDER_KEYS as readonly string[]).includes(name)) {
		issues.push(`Custom provider name "${name}" is a reserved key.`);
	}
	if (name === "__proto__") {
		issues.push(`Custom provider name "${name}" is unsafe.`);
	}
	return issues;
}
