/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { encodeGatewayMetadata, parseWorkbenchGatewayMetadata } from "../connect-gateway-metadata";

describe("encodeGatewayMetadata", () => {
	it("encodes Workbench keys first, then sorted user keys", () => {
		const { header, rejected } = encodeGatewayMetadata({
			team: "alpha",
			"workbench-project-path": "~/proj a",
			"workbench-session-id": "ab12cd34",
		});
		expect(header).toBe(
			"workbench-session-id=ab12cd34,workbench-project-path=~%2Fproj%20a,team=alpha",
		);
		expect(rejected).toEqual([]);
	});

	it("returns no header for undefined or empty", () => {
		expect(encodeGatewayMetadata(undefined)).toEqual({ header: undefined, rejected: [] });
		expect(encodeGatewayMetadata({})).toEqual({ header: undefined, rejected: [] });
	});

	it("escapes commas and equals", () => {
		expect(encodeGatewayMetadata({ note: "a,b=c" }).header).toBe("note=a%2Cb%3Dc");
	});

	it("rejects bad keys, controls, and invalid Unicode", () => {
		for (const key of ["Team", "bad_key"]) {
			expect(encodeGatewayMetadata({ [key]: "a" }).rejected).toHaveLength(1);
		}
		expect(encodeGatewayMetadata({ note: "a\nb" }).header).toBeUndefined();
		expect(encodeGatewayMetadata({ note: "\uD800" }).rejected).toEqual([
			{ key: "note", reason: "is not valid Unicode" },
		]);
	});

	it("bounds entries, encoded values, and header bytes", () => {
		expect(encodeGatewayMetadata({ a: "x".repeat(513) }).header).toBeUndefined();
		const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
		expect(encodeGatewayMetadata(many).header!.split(",")).toHaveLength(16);
		const large = Object.fromEntries(
			Array.from({ length: 9 }, (_, i) => [`k${i}`, "x".repeat(500)]),
		);
		const { header, rejected } = encodeGatewayMetadata({ "workbench-session-id": "s", ...large });
		expect(header).toContain("workbench-session-id=s");
		expect(header!.length).toBeLessThanOrEqual(4096);
		expect(rejected.some(({ reason }) => reason === "header would exceed 4096 bytes")).toBe(true);
	});
});

describe("parseWorkbenchGatewayMetadata", () => {
	it("accepts the Workbench object without consulting the process environment", () => {
		expect(
			parseWorkbenchGatewayMetadata(
				JSON.stringify({
					"workbench-session-id": "s",
					"workbench-project-name": "analysis",
					team: "a",
				}),
			),
		).toEqual({
			metadata: { "workbench-session-id": "s", "workbench-project-name": "analysis", team: "a" },
			warnings: [],
		});
		expect(parseWorkbenchGatewayMetadata(undefined)).toEqual({ metadata: undefined, warnings: [] });
	});

	it("rejects malformed, non-object, and oversized input without throwing", () => {
		for (const value of ["{", "[]", "null", '"x"', "x".repeat(16385)]) {
			const result = parseWorkbenchGatewayMetadata(value);
			expect(result.metadata).toBeUndefined();
			expect(result.warnings).toHaveLength(1);
		}
	});

	it("retains Workbench identity while dropping invalid and reserved fields", () => {
		const result = parseWorkbenchGatewayMetadata(
			JSON.stringify({
				"workbench-session-id": "real",
				"workbench-session-other": "fake",
				bad_key: "x",
				team: "a\nb",
				note: 42,
			}),
		);
		expect(result.metadata).toEqual({ "workbench-session-id": "real" });
		expect(result.warnings).toHaveLength(4);
	});

	it("caps user fields without letting invalid fields consume a slot", () => {
		const fields: Record<string, string> = { "workbench-session-id": "s", blank: " " };
		for (let i = 0; i < 10; i++) fields[`k${i}`] = "v";
		const { metadata, warnings } = parseWorkbenchGatewayMetadata(JSON.stringify(fields));
		expect(Object.keys(metadata!).filter((key) => key.startsWith("k"))).toHaveLength(8);
		expect(warnings).toHaveLength(2);
	});

	it("preserves session priority when user fields fill the 4 KiB header", () => {
		const fields: Record<string, string> = { "workbench-session-id": "s".repeat(512) };
		for (let i = 0; i < 8; i++) fields[`k${i}`] = "x".repeat(500);
		const { metadata, warnings } = parseWorkbenchGatewayMetadata(JSON.stringify(fields));
		expect(metadata).toHaveProperty("workbench-session-id", "s".repeat(512));
		expect(warnings).toContain(
			'Ignoring gateway metadata field "k7": header would exceed 4096 bytes',
		);
	});
});
