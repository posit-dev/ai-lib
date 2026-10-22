/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId, PROVIDER_CONNECTION_DEFAULTS } from "ai-config";
import type { ResolvedConnection, ResolvedProvider } from "ai-config";
import { describe, expect, it } from "vitest";

import { customizedConnectionFields, toHeadlessProviderData } from "../catalog-data";

function resolvedProvider(
	id: ResolvedProvider["id"],
	connection: ResolvedConnection,
): ResolvedProvider {
	return {
		id,
		clientKind: "openai-compatible",
		enabled: true,
		connection,
		connectionProvenance: {},
		models: undefined,
	};
}

describe("customizedConnectionFields", () => {
	it("reports nothing when the resolved connection only carries the built-in defaults", () => {
		expect(
			customizedConnectionFields(
				{ baseUrl: "https://gateway.posit.ai", googleCloud: { location: "us-central1" } },
				{ baseUrl: "https://gateway.posit.ai", googleCloud: { location: "us-central1" } },
			),
		).toBeUndefined();
	});

	it("reports only the fields that differ from the defaults", () => {
		expect(
			customizedConnectionFields(
				{
					baseUrl: "https://gateway.example.corp",
					googleCloud: { location: "us-central1", project: "my-project" },
					azure: { authMode: "entra", scope: "https://cognitiveservices.azure.com/.default" },
				},
				{
					baseUrl: "https://gateway.posit.ai",
					googleCloud: { location: "us-central1" },
					azure: { authMode: "apikey", scope: "https://cognitiveservices.azure.com/.default" },
				},
			),
		).toEqual(["baseUrl", "googleCloud.project", "azure.authMode"]);
	});

	it("reports every set field for a provider with no defaults, e.g. a custom entry", () => {
		expect(
			customizedConnectionFields(
				{
					baseUrl: "https://gateway.example.corp",
					customHeaders: { "X-Route": "a" },
					aws: { profile: "work", region: undefined },
				},
				undefined,
			),
		).toEqual(["baseUrl", "customHeaders", "aws.profile"]);
	});

	it("treats an empty customHeaders map and an untouched connection as nothing to report", () => {
		expect(customizedConnectionFields({ customHeaders: {} }, undefined)).toBeUndefined();
		expect(customizedConnectionFields({}, undefined)).toBeUndefined();
	});
});

describe("toHeadlessProviderData", () => {
	it("maps a stock positai entry to its base URL and login scope", () => {
		const defaults = PROVIDER_CONNECTION_DEFAULTS.positai;

		expect(toHeadlessProviderData(resolvedProvider("positai", { ...defaults }))).toEqual({
			id: "positai",
			enabled: true,
			baseUrl: defaults?.baseUrl,
			positaiLoginScope: defaults?.positaiLogin?.scope,
		});
	});

	it("passes through a configured baseUrl and marks it customized", () => {
		const data = toHeadlessProviderData(
			resolvedProvider("openai", { baseUrl: "https://openai.example.corp" }),
		);

		expect(data).toEqual({
			id: "openai",
			enabled: true,
			baseUrl: "https://openai.example.corp",
			customizedConnection: ["baseUrl"],
		});
	});

	it("flags a custom entry and reports its baseUrl as customized", () => {
		const data = toHeadlessProviderData(
			resolvedProvider(mintCustomProviderId("gateway"), { baseUrl: "https://gw.example.corp" }),
		);

		expect(data).toEqual({
			id: "gateway",
			enabled: true,
			custom: true,
			baseUrl: "https://gw.example.corp",
			customizedConnection: ["baseUrl"],
		});
	});

	it("never carries a customHeaders value", () => {
		const data = toHeadlessProviderData(
			resolvedProvider("openai", { customHeaders: { "X-Secret": "s3cret-value" } }),
		);

		expect(JSON.stringify(data)).not.toContain("s3cret-value");
		expect(data.customizedConnection).toEqual(["customHeaders"]);
	});
});
