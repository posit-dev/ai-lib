/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import { buildCatalog } from "../build-catalog";
import type { EnablementLayer } from "../resolve-enabled";
import type { PlatformBaseline, ProvidersConfig } from "../types";

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

function emptyConfig(): ProvidersConfig {
	return { $schema: "", version: 1, providers: {} };
}

describe("buildCatalog external mode", () => {
	it("includes custom providers when external is false", () => {
		const catalog = buildCatalog(configWithCustom(), layersOf(configWithCustom()), BASELINE, {
			external: false,
		});
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeDefined();
		expect(customEntry!.clientKind).toBe("openai-compatible");
	});

	it("excludes custom providers when external is true", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = buildCatalog(configWithCustom(), layersOf(configWithCustom()), BASELINE, {
			external: true,
			logger,
		});
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("ignoring 1 custom provider(s)"),
		);
	});

	it("does not warn when external is true but no custom providers exist", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = buildCatalog(emptyConfig(), layersOf(emptyConfig()), BASELINE, {
			external: true,
			logger,
		});
		// Only built-in providers in catalog
		expect(catalog.length).toBe(14);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("includes custom providers when options is undefined (default)", () => {
		const catalog = buildCatalog(configWithCustom(), layersOf(configWithCustom()), BASELINE);
		const customEntry = catalog.find((p) => p.id === "my-gateway");
		expect(customEntry).toBeDefined();
	});
});
