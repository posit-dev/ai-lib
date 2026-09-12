/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { additiveHeaderRecord, additiveHeaders } from "../custom-headers";

const PRODUCT_USER_AGENT = "PositAssistant/1.0 posit_test";
const SDK_USER_AGENT = "ai-sdk/openai/3.0 runtime/node.js/v22";

describe("custom User-Agent merging", () => {
	it("prepends the custom identity to an existing SDK User-Agent", () => {
		const headers = additiveHeaders(
			{ "User-Agent": SDK_USER_AGENT },
			{ "user-agent": PRODUCT_USER_AGENT },
		);

		expect(headers.get("user-agent")).toBe(`${PRODUCT_USER_AGENT} ${SDK_USER_AGENT}`);
	});

	it("is idempotent and does not confuse near-prefix identities", () => {
		const once = additiveHeaders(
			{ "User-Agent": SDK_USER_AGENT },
			{ "User-Agent": PRODUCT_USER_AGENT },
		);
		const twice = additiveHeaders(once, { "User-Agent": PRODUCT_USER_AGENT });
		expect(twice.get("user-agent")).toBe(`${PRODUCT_USER_AGENT} ${SDK_USER_AGENT}`);

		const nearPrefix = additiveHeaders(
			{ "User-Agent": "Agent/10 ai-sdk/openai/3.0" },
			{ "User-Agent": "Agent/1" },
		);
		expect(nearPrefix.get("user-agent")).toBe("Agent/1 Agent/10 ai-sdk/openai/3.0");
	});

	it("applies the same policy to plain header records", () => {
		expect(
			additiveHeaderRecord(
				{ Authorization: "Bearer key", "user-agent": SDK_USER_AGENT },
				{ "User-Agent": PRODUCT_USER_AGENT, "x-tenant": "acme" },
			),
		).toEqual({
			Authorization: "Bearer key",
			"user-agent": `${PRODUCT_USER_AGENT} ${SDK_USER_AGENT}`,
			"x-tenant": "acme",
		});
	});
});
