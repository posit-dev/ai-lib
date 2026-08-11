/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * CJS consumability guard.
 *
 * Positron's authentication extension is loaded by the extension host as
 * CommonJS and now imports the pure entry **statically** (the migration
 * wrapper calls `translateLegacyPositronSettings` synchronously), which
 * compiles to `require("ai-config")`. That only resolves if the exports map
 * carries a `require` condition; Node then loads the ESM dist synchronously
 * via require(esm) — unflagged only on Node ≥ 22.12 / ≥ 20.19, the floor
 * declared in package.json `engines`. Dropping the condition would not fail any
 * import-based consumer — only that CJS path — so pin it here. Requires the
 * built `dist/` (CI builds before testing).
 */

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const cjsRequire = createRequire(import.meta.url);

describe("ai-config CJS consumability", () => {
	it("the pure entry is require()-able and exposes the legacy translator", () => {
		const mod = cjsRequire("ai-config");
		expect(typeof mod.translateLegacyPositronSettings).toBe("function");
		expect(typeof mod.legacySettingKeys).toBe("function");
	});

	it("the node entry is require()-able", () => {
		const mod = cjsRequire("ai-config/node");
		expect(typeof mod.loadResolvedProviderCatalog).toBe("function");
	});

	it("the JSONC entry is require()-able", () => {
		const mod = cjsRequire("ai-config/jsonc");
		expect(typeof mod.editJsonc).toBe("function");
		expect(typeof mod.normalizeJsonValue).toBe("function");
	});
});
