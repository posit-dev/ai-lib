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
		const catalog = buildCatalog(
			configWithCustom(),
			layersOf(configWithCustom()),
			BASELINE,
			new Map(),
		);
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeDefined();
		expect(customEntry!.clientKind).toBe("openai-compatible");
	});

	it("preserves a custom Portkey display id and base connection fields", () => {
		const config: ProvidersConfig = {
			$schema: "",
			version: 1,
			providers: {
				custom: {
					"acme-portkey": {
						type: "portkey",
						baseUrl: "https://ai-gateway.acme.com",
						customHeaders: { "x-portkey-provider": "openai" },
						protocol: "openai-chat",
					},
				},
			},
		};

		const entry = buildCatalog(config, layersOf(config), BASELINE, new Map()).find(
			(provider) => provider.id === "acme-portkey",
		);

		expect(entry).toMatchObject({
			id: "acme-portkey",
			clientKind: "portkey",
			connection: {
				baseUrl: "https://ai-gateway.acme.com",
				customHeaders: { "x-portkey-provider": "openai" },
				protocol: "openai-chat",
			},
		});
	});
});
