/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

describe("ai-config", () => {
	it("pure entry module loads", async () => {
		const mod = await import("../index");
		expect(mod).toBeDefined();
	});

	it("node entry module loads", async () => {
		const mod = await import("../node/index");
		expect(mod).toBeDefined();
	});
});
