/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { CONFIG_KEY_OVERRIDES, POSITRON_LEGACY_AUTH_PROVIDER_IDS } from "ai-credentials/types";
import { describe, expect, it } from "vitest";

import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map";

/** Auth ids another extension owns, so they cannot equal the catalog id. */
const FOREIGN_AUTH_IDS = {
	copilot: "github",
	"posit-connect": "posit-connect-llm",
} as const;

describe("PROVIDER_MAP auth provider ids", () => {
	it("uses the catalog id as the auth provider id except where another extension owns the id", () => {
		const mismatches = MAPPED_PROVIDER_IDS.filter(
			(id) => !(id in FOREIGN_AUTH_IDS) && PROVIDER_MAP[id]?.authProviderId !== id,
		);
		expect(mismatches).toEqual([]);
		for (const [id, authProviderId] of Object.entries(FOREIGN_AUTH_IDS)) {
			expect(PROVIDER_MAP[id as keyof typeof FOREIGN_AUTH_IDS]?.authProviderId).toBe(
				authProviderId,
			);
		}
	});

	it("keeps the legacy settings section for every apikey provider", () => {
		const configKeys = Object.fromEntries(
			MAPPED_PROVIDER_IDS.filter((id) => PROVIDER_MAP[id]?.credentialType === "apikey").map(
				(id) => {
					const authProviderId = PROVIDER_MAP[id]!.authProviderId;
					return [id, CONFIG_KEY_OVERRIDES[authProviderId] ?? authProviderId];
				},
			),
		);
		expect(configKeys).toEqual({
			anthropic: "anthropic",
			openai: "openai-api",
			gemini: "google",
			litellm: "litellm",
			portkey: "portkey",
			"posit-connect": "posit-connect-llm",
			"openai-compatible": "openai-compatible",
			"ms-foundry": "foundry",
			"snowflake-cortex": "snowflake",
			copilot: "github",
			deepseek: "deepseek-api",
			databricks: "databricks",
		});
	});

	it("maps every legacy Positron auth id to a mapped provider", () => {
		expect(POSITRON_LEGACY_AUTH_PROVIDER_IDS).toEqual({
			anthropic: "anthropic-api",
			openai: "openai-api",
			gemini: "google",
			deepseek: "deepseek-api",
			positai: "posit-ai",
			bedrock: "amazon-bedrock",
			"google-vertex": "google-cloud",
		});
		for (const id of Object.keys(POSITRON_LEGACY_AUTH_PROVIDER_IDS)) {
			expect(MAPPED_PROVIDER_IDS).toContain(id);
		}
	});
});
