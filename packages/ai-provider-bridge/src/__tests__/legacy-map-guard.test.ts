/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this file with
// ai-config's legacy-positron-settings module.

/**
 * Guard: ai-config's legacy connection rows stay in sync with the bridge.
 *
 * ai-config owns the legacy Positron settings → providers.json map but must
 * not import the bridge, so its connection rows duplicate the derivation from
 * `PROVIDER_MAP` + `CONFIG_KEY_OVERRIDES` (every `apikey` provider except the
 * snowflake/databricks special cases). This test runs in the bridge — which
 * may import ai-config — and pins the two against each other. It is the
 * runtime counterpart of the compile-time guards in `typechecks/`
 * (`PROVIDER_MAP`'s declared type is deliberately non-literal, so this
 * assertion cannot be expressed there).
 */

import { LEGACY_CONNECTION_ROWS } from "ai-config";
import { describe, expect, it } from "vitest";

import { CONFIG_KEY_OVERRIDES } from "../credential-shaping";
import { PROVIDER_MAP } from "../provider-map";

/** The credential-section special cases the connection rows must NOT cover. */
const CREDENTIAL_SECTION_PROVIDERS = new Set(["snowflake-cortex", "databricks"]);

function deriveConnectionRows(): Array<{ configKey: string; providerId: string }> {
	return Object.entries(PROVIDER_MAP)
		.filter(
			([providerId, mapping]) =>
				mapping.credentialType === "apikey" && !CREDENTIAL_SECTION_PROVIDERS.has(providerId),
		)
		.map(([providerId, mapping]) => ({
			configKey: CONFIG_KEY_OVERRIDES[mapping.authProviderId] ?? mapping.authProviderId,
			providerId,
		}));
}

describe("legacy connection rows ↔ bridge derivation", () => {
	it("every derived apikey row has a matching map row", () => {
		const mapRows = new Set(
			LEGACY_CONNECTION_ROWS.map((row) => `${row.configKey} → ${row.providerId}`),
		);
		for (const derived of deriveConnectionRows()) {
			expect(mapRows).toContain(`${derived.configKey} → ${derived.providerId}`);
		}
	});

	it("the map's only non-derived connection row is googleVertex → google-vertex", () => {
		// google-vertex is declared extra: its PROVIDER_MAP credentialType is
		// `google-cloud`, so it is not derivable from the apikey rule, but its
		// legacy `authentication.googleVertex.{baseUrl,customHeaders}` settings
		// are real and must translate.
		const derived = new Set(
			deriveConnectionRows().map((row) => `${row.configKey} → ${row.providerId}`),
		);
		const extras = LEGACY_CONNECTION_ROWS.filter(
			(row) => !derived.has(`${row.configKey} → ${row.providerId}`),
		);
		expect(extras).toEqual([{ configKey: "googleVertex", providerId: "google-vertex" }]);
	});
});
