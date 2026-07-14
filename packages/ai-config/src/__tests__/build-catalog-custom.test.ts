/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { buildCatalog } from "../build-catalog.js";
import type { EnablementLayer } from "../resolve-enabled.js";
import type { PlatformBaseline, ProvidersConfig } from "../types.js";

/** Build the highest-first enablement layer stack from a config's providers map. */
function layersOf(config: ProvidersConfig): EnablementLayer[] {
	return [config.providers];
}

const BASELINE: PlatformBaseline = { defaultEnabled: true };

function configWithCustom(): ProvidersConfig {
	return {
		$schema: "",
		version: 1,
		providers: {
			custom: {
				"my-gateway": {
					type: "openai-compatible" as const,
					baseUrl: "https://gateway.example.com/v1",
				},
			},
		},
	};
}

describe("buildCatalog custom providers", () => {
	it("includes custom providers", () => {
		const catalog = buildCatalog(configWithCustom(), layersOf(configWithCustom()), BASELINE, {});
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeDefined();
		expect(customEntry!.clientKind).toBe("openai-compatible");
	});

	it("includes custom providers when options is undefined (default)", () => {
		const catalog = buildCatalog(configWithCustom(), layersOf(configWithCustom()), BASELINE);
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeDefined();
	});
});
