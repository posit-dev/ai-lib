/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	encodeGatewayMetadata,
	gatewayMetadataFromEnv,
	withGatewayMetadata,
} from "../connect-gateway-metadata";

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

	it("rejects bad keys", () => {
		for (const key of ["Team", "bad_key"]) {
			const { header, rejected } = encodeGatewayMetadata({ [key]: "a" });
			expect(header).toBeUndefined();
			expect(rejected).toHaveLength(1);
		}
	});

	it("rejects a lone surrogate without throwing", () => {
		const { header, rejected } = encodeGatewayMetadata({ note: "\uD800" });
		expect(header).toBeUndefined();
		expect(rejected).toEqual([{ key: "note", reason: "is not valid Unicode" }]);
	});

	it("rejects control characters", () => {
		const { header, rejected } = encodeGatewayMetadata({ note: "a\nb" });
		expect(header).toBeUndefined();
		expect(rejected).toHaveLength(1);
	});

	it("treats blank values as absent without reporting", () => {
		expect(encodeGatewayMetadata({ note: "   " })).toEqual({ header: undefined, rejected: [] });
	});

	it("bounds the encoded value at 512 bytes", () => {
		expect(encodeGatewayMetadata({ a: "x".repeat(512) }).header).toBeDefined();
		const { header, rejected } = encodeGatewayMetadata({ a: "x".repeat(513) });
		expect(header).toBeUndefined();
		expect(rejected[0].reason).toBe("longer than 512 encoded bytes");
	});

	it("bounds the header, keeping Workbench entries first", () => {
		const metadata: Record<string, string> = {
			"workbench-session-id": "s",
			"workbench-session-name": "n",
			"workbench-project-name": "pn",
			"workbench-project-path": "pp",
		};
		for (let i = 0; i < 8; i++) metadata[`user${i}`] = "x".repeat(500);
		const { header, rejected } = encodeGatewayMetadata(metadata);
		expect(header!.length).toBeLessThanOrEqual(4096);
		for (const key of Object.keys(metadata).filter((k) => k.startsWith("workbench-"))) {
			expect(header).toContain(`${key}=`);
		}
		expect(rejected.length).toBeGreaterThan(0);
		expect(rejected.every((r) => r.reason === "header would exceed 4096 bytes")).toBe(true);
		expect(rejected.every((r) => r.key.startsWith("user"))).toBe(true);
	});

	it("rejects entries past 16", () => {
		const metadata: Record<string, string> = {};
		for (let i = 0; i < 17; i++) metadata[`k${String(i).padStart(2, "0")}`] = "v";
		const { header, rejected } = encodeGatewayMetadata(metadata);
		expect(header!.split(",")).toHaveLength(16);
		expect(rejected).toEqual([{ key: "k16", reason: "more than 16 fields" }]);
	});
});

describe("gatewayMetadataFromEnv", () => {
	it("maps Workbench and user variables", () => {
		expect(
			gatewayMetadataFromEnv({
				PWB_SESSION_ID: "ab12cd34",
				PWB_SESSION_NAME: "My Session",
				POSIT_GATEWAY_META_COST_CENTER: "42",
				OTHER: "y",
			}),
		).toEqual({
			metadata: {
				"workbench-session-id": "ab12cd34",
				"workbench-session-name": "My Session",
				"cost-center": "42",
			},
			warnings: [],
		});
	});

	it("returns undefined for an empty environment", () => {
		expect(gatewayMetadataFromEnv({})).toEqual({ metadata: undefined, warnings: [] });
	});

	it("reserves the workbench- prefix", () => {
		const { metadata, warnings } = gatewayMetadataFromEnv({
			PWB_SESSION_ID: "real",
			POSIT_GATEWAY_META_WORKBENCH_SESSION_ID: "fake",
		});
		expect(metadata).toEqual({ "workbench-session-id": "real" });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("POSIT_GATEWAY_META_WORKBENCH_SESSION_ID");
	});

	it("warns on an empty suffix", () => {
		const { metadata, warnings } = gatewayMetadataFromEnv({ POSIT_GATEWAY_META_: "x" });
		expect(metadata).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("POSIT_GATEWAY_META_");
	});

	it("drops colliding keys with one warning naming both", () => {
		const { metadata, warnings } = gatewayMetadataFromEnv({
			POSIT_GATEWAY_META_TEAM: "a",
			POSIT_GATEWAY_META_team: "b",
		});
		expect(metadata).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("POSIT_GATEWAY_META_TEAM");
		expect(warnings[0]).toContain("POSIT_GATEWAY_META_team");
	});

	it("keeps at most 8 user keys", () => {
		const env: Record<string, string> = {};
		for (let i = 0; i < 10; i++) env[`POSIT_GATEWAY_META_K${i}`] = "v";
		const { metadata, warnings } = gatewayMetadataFromEnv(env);
		expect(Object.keys(metadata!).sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("POSIT_GATEWAY_META_K8");
		expect(warnings[1]).toContain("POSIT_GATEWAY_META_K9");
	});

	it("does not count invalid or blank user fields toward the eight-field limit", () => {
		const env: Record<string, string> = {
			POSIT_GATEWAY_META_A_BLANK: "   ",
			POSIT_GATEWAY_META_A_CONTROL: "a\nb",
			POSIT_GATEWAY_META_A_UNICODE: "\uD800",
			POSIT_GATEWAY_META_A_TOO_LONG: "x".repeat(513),
			"POSIT_GATEWAY_META_-BAD": "x",
		};
		for (let i = 0; i < 9; i++) env[`POSIT_GATEWAY_META_B${i}`] = "v";

		const { metadata, warnings } = gatewayMetadataFromEnv(env);
		expect(metadata).toEqual(
			Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`b${i}`, "v"])),
		);
		expect(warnings).toEqual([
			"Ignoring POSIT_GATEWAY_META_-BAD: not 1-32 lowercase letters, digits, or hyphens",
			"Ignoring POSIT_GATEWAY_META_A_CONTROL: contains control characters",
			"Ignoring POSIT_GATEWAY_META_A_TOO_LONG: longer than 512 encoded bytes",
			"Ignoring POSIT_GATEWAY_META_A_UNICODE: is not valid Unicode",
			"Ignoring POSIT_GATEWAY_META_B8: more than 8 user fields",
		]);
	});

	it("does not spend a user slot on fields that exceed the combined header limit", () => {
		const env: Record<string, string> = { PWB_SESSION_ID: "x".repeat(512) };
		for (let i = 0; i < 8; i++) env[`POSIT_GATEWAY_META_K${i}`] = "x".repeat(500);
		env.POSIT_GATEWAY_META_K8 = "short";
		const { metadata, warnings } = gatewayMetadataFromEnv(env);
		expect(metadata).toHaveProperty("workbench-session-id");
		expect(Object.keys(metadata!).filter((key) => key.startsWith("k"))).toHaveLength(8);
		expect(metadata).toHaveProperty("k8", "short");
		expect(metadata).not.toHaveProperty("k7");
		expect(warnings).toEqual(["Ignoring POSIT_GATEWAY_META_K7: header would exceed 4096 bytes"]);
	});

	it("warns about invalid values", () => {
		const { warnings } = gatewayMetadataFromEnv({ POSIT_GATEWAY_META_NOTE: "x".repeat(600) });
		expect(warnings).toEqual(["Ignoring POSIT_GATEWAY_META_NOTE: longer than 512 encoded bytes"]);
	});
});

describe("withGatewayMetadata", () => {
	it("returns the same object when there is no gateway metadata", () => {
		const metadata = { sessionId: "s" };
		expect(withGatewayMetadata(metadata, undefined)).toBe(metadata);
	});

	it("creates metadata when there was none", () => {
		const m = { team: "a" };
		expect(withGatewayMetadata(undefined, m)).toEqual({ gatewayMetadata: m });
	});
});
