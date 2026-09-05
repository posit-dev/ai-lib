/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import type { ResolvedModelInfo } from "../../types.js";
import type { Protocol } from "../../vocabulary.js";
import {
	finalizeWebSearchCapability,
	resolveWebSearchServing,
	type WebSearchServing,
} from "../web-search.js";

function makeResolved(
	id: string,
	overrides?: {
		supportsWebSearch?: boolean;
		resolvedProtocol?: Protocol;
		resolvedBaseUrl?: string;
	},
): ResolvedModelInfo {
	return {
		id,
		name: id,
		maxContextLength: 100000,
		supportsTools: true,
		supportsImages: false,
		supportsToolResultImages: false,
		supportsWebSearch: overrides?.supportsWebSearch ?? false,
		resolvedProtocol: overrides?.resolvedProtocol,
		resolvedBaseUrl: overrides?.resolvedBaseUrl,
	};
}

const OPENAI_BUILTIN: WebSearchServing = { kind: "openai-builtin" };
const OPENAI_CUSTOM: WebSearchServing = { kind: "openai-custom" };
const MANTLE = (awsRegion: string, awsFips?: boolean): WebSearchServing => ({
	kind: "bedrock-mantle",
	awsRegion,
	awsFips,
});

describe("resolveWebSearchServing", () => {
	it("classifies the built-in OpenAI provider", () => {
		expect(resolveWebSearchServing({ id: "openai", clientKind: "openai" })).toEqual({
			kind: "openai-builtin",
		});
	});

	it("classifies a custom OpenAI provider", () => {
		expect(resolveWebSearchServing({ id: "my-gateway", clientKind: "openai" })).toEqual({
			kind: "openai-custom",
		});
	});

	it("classifies AWS providers with the effective region and FIPS flag", () => {
		expect(
			resolveWebSearchServing(
				{ id: "bedrock", clientKind: "aws", connection: { aws: { region: "us-west-2" } } },
				false,
			),
		).toEqual({ kind: "bedrock-mantle", awsRegion: "us-west-2", awsFips: false });
	});

	it("falls back to the default Bedrock region when the connection omits one", () => {
		expect(resolveWebSearchServing({ id: "bedrock", clientKind: "aws" })).toEqual({
			kind: "bedrock-mantle",
			awsRegion: "us-east-1",
			awsFips: undefined,
		});
	});

	it("returns undefined for providers outside the policy", () => {
		expect(resolveWebSearchServing({ id: "anthropic", clientKind: "anthropic" })).toBeUndefined();
		expect(
			resolveWebSearchServing({ id: "openai-compatible", clientKind: "openai-compatible" }),
		).toBeUndefined();
		expect(resolveWebSearchServing({ id: "databricks", clientKind: "databricks" })).toBeUndefined();
	});
});

describe("finalizeWebSearchCapability", () => {
	describe("without a serving context", () => {
		it("passes the resolved capability through unchanged", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("anything", { supportsWebSearch: true }),
					undefined,
					undefined,
				),
			).toBe(true);
		});
	});

	describe("built-in OpenAI", () => {
		it("defaults on at the canonical endpoint (unresolved base URL and protocol)", () => {
			expect(
				finalizeWebSearchCapability(makeResolved("gpt-5.6-sol"), undefined, OPENAI_BUILTIN),
			).toBe(true);
		});

		it("treats the explicit canonical base URL as canonical", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedBaseUrl: "https://api.openai.com/v1/" }),
					undefined,
					OPENAI_BUILTIN,
				),
			).toBe(true);
		});

		it("honors an explicit opt-out at the canonical endpoint", () => {
			expect(finalizeWebSearchCapability(makeResolved("gpt-5.6-sol"), false, OPENAI_BUILTIN)).toBe(
				false,
			);
		});

		it("defaults off on a redirected endpoint", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedBaseUrl: "https://gateway.example.com/v1" }),
					undefined,
					OPENAI_BUILTIN,
				),
			).toBe(false);
		});

		it("allows an explicit opt-in on a redirected Responses endpoint", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedBaseUrl: "https://gateway.example.com/v1" }),
					true,
					OPENAI_BUILTIN,
				),
			).toBe(true);
		});

		it("never enables on the Chat Completions route, even with an explicit opt-in", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedProtocol: "openai-chat" }),
					true,
					OPENAI_BUILTIN,
				),
			).toBe(false);
		});

		it("never enables on the MLflow Responses route", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedProtocol: "mlflow-responses" }),
					true,
					OPENAI_BUILTIN,
				),
			).toBe(false);
		});
	});

	describe("custom OpenAI", () => {
		it("defaults off without an explicit declaration", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					undefined,
					OPENAI_CUSTOM,
				),
			).toBe(false);
		});

		it("enables on an explicit opt-in with Responses routing", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					true,
					OPENAI_CUSTOM,
				),
			).toBe(true);
		});

		it("rejects an explicit opt-in on the Chat Completions route", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("gpt-5.6-sol", { resolvedProtocol: "openai-chat" }),
					true,
					OPENAI_CUSTOM,
				),
			).toBe(false);
		});
	});

	describe("Bedrock Mantle", () => {
		it("enables a documented GPT family on the Responses route in a supported region", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					undefined,
					MANTLE("us-east-1", false),
				),
			).toBe(true);
		});

		it("honors an explicit opt-out", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					false,
					MANTLE("us-east-1", false),
				),
			).toBe(false);
		});

		it("lets no explicit opt-in bypass the family gate", () => {
			for (const id of ["openai.gpt-oss-120b", "openai.gpt-5.9", "openai.future-model"]) {
				expect(
					finalizeWebSearchCapability(
						makeResolved(id, { resolvedProtocol: "openai-responses" }),
						true,
						MANTLE("us-east-1", false),
					),
				).toBe(false);
			}
		});

		it("lets no explicit opt-in bypass the route gate", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol", { resolvedProtocol: "openai-chat" }),
					true,
					MANTLE("us-east-1", false),
				),
			).toBe(false);
			// An unresolved protocol means the Converse/Anthropic heuristic route.
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol"),
					true,
					MANTLE("us-east-1", false),
				),
			).toBe(false);
		});

		it("lets no explicit opt-in bypass the region gate", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					true,
					MANTLE("eu-west-1", false),
				),
			).toBe(false);
		});

		it("lets no explicit opt-in bypass the FIPS gate", () => {
			expect(
				finalizeWebSearchCapability(
					makeResolved("openai.gpt-5.6-sol", { resolvedProtocol: "openai-responses" }),
					true,
					MANTLE("us-east-1", true),
				),
			).toBe(false);
		});
	});
});
