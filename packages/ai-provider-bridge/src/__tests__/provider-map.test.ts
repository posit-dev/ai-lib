/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { POSITRON_LEGACY_AUTH_PROVIDER_IDS } from "ai-credentials/types";
import { describe, expect, it } from "vitest";

import { LOCAL_PROVIDER_IDS } from "../local-providers";
import { MAPPED_PROVIDER_IDS, PROVIDER_MAP } from "../provider-map";
import { PROVIDER_IDS } from "../types";

/** Providers without an auth mapping that aren't local: `copilot` is reached only via vscode.lm. */
const UNMAPPED_EXEMPT = ["copilot"];

describe("PROVIDER_MAP auth provider ids", () => {
	it("defaults the auth provider id to the catalog id", () => {
		expect(PROVIDER_MAP.anthropic?.authProviderId).toBe("anthropic");
	});

	it("avoids an auth provider id another extension owns", () => {
		expect(PROVIDER_MAP["posit-connect"]?.authProviderId).toBe("posit-connect-llm");
	});

	it("maps every provider except local ones and the exempt list", () => {
		const exempt: readonly string[] = [...LOCAL_PROVIDER_IDS, ...UNMAPPED_EXEMPT];
		const missing = PROVIDER_IDS.filter((id) => !exempt.includes(id) && !(id in PROVIDER_MAP));
		expect(missing).toEqual([]);
	});

	it("maps every legacy Positron auth id to a mapped provider", () => {
		for (const id of Object.keys(POSITRON_LEGACY_AUTH_PROVIDER_IDS)) {
			expect(MAPPED_PROVIDER_IDS).toContain(id);
		}
	});
});
