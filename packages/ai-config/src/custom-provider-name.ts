/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isBuiltinProviderId, RESERVED_PROVIDER_KEYS } from "./vocabulary.js";

/**
 * Auth-provider ids owned by another extension or by Assistant's own
 * aggregate, not by a catalog provider id. A custom entry under one of these
 * names would be read through the aggregate with a scope colliding with an
 * existing auth-provider id. Private: a deny-list for this validator, not
 * catalog vocabulary.
 */
const FOREIGN_AUTH_PROVIDER_IDS: readonly string[] = [
	"github",
	"posit-connect-llm",
	"custom-providers",
	"positron-custom-provider",
];

/** Shared custom-provider name policy for strict parsing, salvage, and branded ids. */
export function customProviderNameIssues(name: string): readonly string[] {
	const issues: string[] = [];
	if (isBuiltinProviderId(name)) {
		issues.push(`Custom provider name "${name}" collides with a built-in provider id.`);
	}
	if ((RESERVED_PROVIDER_KEYS as readonly string[]).includes(name)) {
		issues.push(`Custom provider name "${name}" is a reserved key.`);
	}
	if (FOREIGN_AUTH_PROVIDER_IDS.includes(name)) {
		issues.push(`Custom provider name "${name}" collides with an authentication provider id.`);
	}
	if (name === "__proto__") {
		issues.push(`Custom provider name "${name}" is unsafe.`);
	}
	return issues;
}
