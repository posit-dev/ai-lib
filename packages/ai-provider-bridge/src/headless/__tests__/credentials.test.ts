/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedConnection } from "ai-config";
import { serializeSessionToken } from "ai-credentials/types";
import { describe, expect, it } from "vitest";

import type { Logger } from "../../types";
import { headlessCredentials } from "../credentials";
import { servableProviders } from "../mappings";

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

function credentialsFor(
	providerId: string,
	connection: ResolvedConnection | undefined,
	sessionToken: string | undefined,
) {
	const servable = servableProviders([]).find((s) => s.mapping.providerId === providerId);
	if (!servable) {
		throw new Error(`no servable for ${providerId}`);
	}
	return headlessCredentials(servable, () => connection, sessionToken, logger);
}

describe("headlessCredentials", () => {
	describe("local providers", () => {
		it("uses the catalog endpoint", () => {
			expect(credentialsFor("ollama", { endpoint: "http://localhost:11434" }, undefined)).toEqual({
				type: "local",
				endpoint: "http://localhost:11434",
			});
		});

		it("ignores a session token", () => {
			expect(credentialsFor("ollama", { endpoint: "http://h:1" }, "tok")).toEqual({
				type: "local",
				endpoint: "http://h:1",
			});
		});

		it("is undefined without an endpoint", () => {
			expect(credentialsFor("ollama", {}, undefined)).toBeUndefined();
			expect(credentialsFor("ollama", undefined, undefined)).toBeUndefined();
		});
	});

	describe("with a session token", () => {
		it("shapes an apikey with the catalog base URL and headers", () => {
			expect(
				credentialsFor(
					"anthropic",
					{ baseUrl: "https://proxy.example", customHeaders: { "x-team": "a" } },
					"sk-1",
				),
			).toEqual({
				type: "apikey",
				apiKey: "sk-1",
				baseUrl: "https://proxy.example",
				customHeaders: { "x-team": "a" },
			});
		});

		it("drops an empty base URL and empty headers", () => {
			expect(credentialsFor("anthropic", { baseUrl: "", customHeaders: {} }, "sk-1")).toEqual({
				type: "apikey",
				apiKey: "sk-1",
				baseUrl: undefined,
				customHeaders: undefined,
			});
		});

		it("shapes an oauth token", () => {
			expect(credentialsFor("positai", {}, "at-1")).toEqual({
				type: "oauth",
				accessToken: "at-1",
			});
		});

		it("builds the AWS envelope with the catalog region", () => {
			const token = serializeSessionToken({
				type: "aws-credentials",
				accessKeyId: "AK",
				secretAccessKey: "SK",
				sessionToken: "ST",
			});
			expect(
				credentialsFor("bedrock", { aws: { region: "eu-west-1", profile: "p" } }, token),
			).toEqual({
				type: "aws-credentials",
				region: "eu-west-1",
				accessKeyId: "AK",
				secretAccessKey: "SK",
				sessionToken: "ST",
				profile: "p",
			});
		});

		it("is undefined for a malformed AWS envelope", () => {
			expect(credentialsFor("bedrock", {}, "not-json")).toBeUndefined();
		});

		it("builds the Snowflake base URL from the account", () => {
			const credentials = credentialsFor(
				"snowflake-cortex",
				{ snowflake: { account: "myorg-acct" } },
				"pat",
			);
			expect(credentials).toMatchObject({ type: "apikey", apiKey: "pat" });
			expect(credentials?.type === "apikey" && credentials.baseUrl).toContain("myorg-acct");
		});

		it("prefers a session over Entra for Foundry", () => {
			expect(
				credentialsFor(
					"ms-foundry",
					{
						baseUrl: "https://f.example",
						azure: { authMode: "entra", scope: "https://s/.default" },
					},
					"bearer",
				),
			).toEqual({
				type: "apikey",
				apiKey: "bearer",
				baseUrl: "https://f.example",
				customHeaders: undefined,
			});
		});
	});

	describe("without a session token", () => {
		it("builds Entra credentials for Foundry", () => {
			expect(
				credentialsFor(
					"ms-foundry",
					{
						baseUrl: "https://f.example",
						customHeaders: { "x-a": "b" },
						azure: { authMode: "entra", scope: "https://s/.default", tenantId: "t1" },
					},
					undefined,
				),
			).toEqual({
				type: "azure-entra",
				baseUrl: "https://f.example",
				scope: "https://s/.default",
				tenantId: "t1",
				customHeaders: { "x-a": "b" },
			});
		});

		it.each([
			["a non-entra auth mode", { baseUrl: "https://f", azure: { authMode: "apikey" as const } }],
			["no scope", { baseUrl: "https://f", azure: { authMode: "entra" as const } }],
			["no base URL", { azure: { authMode: "entra" as const, scope: "s" } }],
		])("is undefined for Foundry with %s", (_name, connection) => {
			expect(credentialsFor("ms-foundry", connection, undefined)).toBeUndefined();
		});

		it("is undefined for an apikey provider", () => {
			expect(credentialsFor("anthropic", { baseUrl: "https://x" }, undefined)).toBeUndefined();
		});
	});

	describe("key-optional providers without a session token", () => {
		it.each(["litellm", "openai-compatible"])(
			"builds an empty-key credential for %s from the catalog base URL and headers",
			(id) => {
				expect(
					credentialsFor(
						id,
						{ baseUrl: "https://gw.example", customHeaders: { "x-a": "b" } },
						undefined,
					),
				).toEqual({
					type: "apikey",
					apiKey: "",
					baseUrl: "https://gw.example",
					customHeaders: { "x-a": "b" },
				});
			},
		);

		it.each([
			["no connection", undefined],
			["no base URL", {}],
			["an empty base URL", { baseUrl: "" }],
		])("is undefined for litellm with %s", (_name, connection) => {
			expect(credentialsFor("litellm", connection, undefined)).toBeUndefined();
		});

		it("lets a session token win over the catalog credential", () => {
			expect(credentialsFor("litellm", { baseUrl: "https://gw.example" }, "sk-1")).toEqual({
				type: "apikey",
				apiKey: "sk-1",
				baseUrl: "https://gw.example",
				customHeaders: undefined,
			});
		});
	});
});
