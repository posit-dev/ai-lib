/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	combineGatewayMetadataHeaders,
	isSafeGatewayMetadataHeader,
} from "../connect-gateway-metadata";

describe("combineGatewayMetadataHeaders", () => {
	it("keeps Workbench identity when a configured header claims a reserved key", () => {
		expect(
			combineGatewayMetadataHeaders("workbench-session-id=s1", {
				"Posit-Connect-Gateway-Metadata": "WORKBENCH%2DSESSION-ID=fake,team=analytics",
			}),
		).toBe("workbench-session-id=s1");
	});

	it("cannot send forged Workbench keys without Workbench metadata", () => {
		expect(
			combineGatewayMetadataHeaders(undefined, {
				"Posit-Connect-Gateway-Metadata": "workbench-project-name=Fake",
			}),
		).toBeUndefined();
	});
});

describe("isSafeGatewayMetadataHeader", () => {
	it("passes an encoded Workbench header without changing it", () => {
		expect(isSafeGatewayMetadataHeader("workbench-project-path=~%2Fmy%20project,team=a%2Cb")).toBe(
			true,
		);
	});

	it("omits empty, oversized, or non-ASCII HTTP header values", () => {
		for (const value of [
			"",
			"x".repeat(4097),
			"key=raw\nnewline",
			"key=raw\rreturn",
			"key=\0",
			"key=é",
		]) {
			expect(isSafeGatewayMetadataHeader(value)).toBe(false);
		}
		expect(isSafeGatewayMetadataHeader("x".repeat(4096))).toBe(true);
	});
});
