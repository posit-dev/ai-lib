/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./vscode-mock"));

import { toProviderId } from "../vscode-lm-models";

describe("toProviderId", () => {
	it("resolves a legacy Positron auth id", () => {
		expect(toProviderId("amazon-bedrock")).toBe("bedrock");
	});

	it("resolves an auth provider id that differs from the catalog id", () => {
		expect(toProviderId("posit-connect-llm")).toBe("posit-connect");
	});

	it("returns undefined for an unknown vendor", () => {
		expect(toProviderId("unknown-vendor")).toBeUndefined();
	});
});
