/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	type DatabricksModelProfile,
	type DatabricksModelProfileInput,
	type DatabricksServedEntityInput,
	inferDatabricksModelProfile,
} from "../databricks-helpers.js";

const GATEWAY_CHAT = "mlflow/v1/chat/completions";
const ANTHROPIC_NATIVE = "anthropic/v1/messages";

/** A pay-per-token foundation-model entity, optionally advertising gateway APIs. */
function foundationEntity(
	name: string,
	api_types?: readonly string[],
	ai_gateway_v2_supported = true,
): DatabricksServedEntityInput {
	return {
		foundation_model: {
			name,
			...(api_types ? { api_types, ai_gateway_v2_supported } : {}),
		},
	};
}

function externalEntity(provider: string, name: string): DatabricksServedEntityInput {
	return { external_model: { provider, name, task: "llm/v1/chat" } };
}

function profile(input: Partial<DatabricksModelProfileInput> = {}): DatabricksModelProfile {
	return inferDatabricksModelProfile({
		surface: "serving",
		endpointName: "endpoint",
		servedEntities: [],
		...input,
	});
}

/** Narrow to the listed variant, failing the test when the endpoint was excluded. */
function listed(
	result: DatabricksModelProfile,
): Extract<DatabricksModelProfile, { excluded: false }> {
	if (result.excluded) {
		throw new Error("expected the endpoint to be listed, but it was excluded");
	}
	return result;
}

describe("inferDatabricksModelProfile — structural eligibility", () => {
	it("routes a pay-per-token Claude foundation model natively with full Anthropic capabilities", () => {
		const result = listed(
			profile({
				endpointName: "databricks-claude-opus-4-8",
				task: "llm/v1/chat",
				servedEntities: [foundationEntity("databricks-claude-opus-4-8")],
			}),
		);

		expect(result.protocol).toBe("anthropic-messages");
		expect(result.vendor).toBe("anthropic");
		// The native route keeps what the chat surface strips.
		expect(result.capabilities.thinkingEffortLevels).toContain("high");
		expect(result.capabilities.supportedInputMediaTypes).toContain("application/pdf");
	});

	it("does not route a Claude identity on a provisioned-throughput or custom endpoint natively", () => {
		const result = listed(
			profile({
				endpointName: "my-pt-claude",
				task: "llm/v1/chat",
				// No foundation_model / external_model: a Unity Catalog model reference.
				servedEntities: [{ entity_name: "system.ai.claude-opus-4-8" }],
			}),
		);

		expect(result.protocol).toBe("openai-chat");
		expect(result.capabilities.thinkingEffortLevels).toBeUndefined();
		expect(result.capabilities.supportedInputMediaTypes).not.toContain("application/pdf");
	});

	it("routes Claude external models natively only for Anthropic-family providers", () => {
		expect(
			listed(
				profile({
					endpointName: "my-claude-route",
					servedEntities: [externalEntity("anthropic", "claude-opus-4-8")],
				}),
			).protocol,
		).toBe("anthropic-messages");
		expect(
			listed(
				profile({
					endpointName: "my-bedrock-claude",
					servedEntities: [externalEntity("amazon-bedrock", "us.anthropic.claude-opus-4-8-v1:0")],
				}),
			).protocol,
		).toBe("anthropic-messages");
		expect(
			listed(
				profile({
					endpointName: "my-other-claude",
					servedEntities: [externalEntity("custom", "claude-opus-4-8")],
				}),
			).protocol,
		).toBe("openai-chat");
	});

	it("does not route a non-chat endpoint natively", () => {
		expect(
			listed(
				profile({
					endpointName: "databricks-claude-opus-4-8",
					task: "llm/v1/embeddings",
					servedEntities: [foundationEntity("databricks-claude-opus-4-8")],
				}),
			).protocol,
		).toBe("openai-chat");
	});
});

describe("inferDatabricksModelProfile — Responses family allowlist", () => {
	it("routes recognized Responses-compatible external OpenAI models with thinking controls", () => {
		const result = listed(
			profile({
				endpointName: "my-gpt-4o-route",
				servedEntities: [externalEntity("openai", "gpt-4o")],
			}),
		);

		expect(result.protocol).toBe("openai-responses");
		expect(result.vendor).toBe("openai");
		expect(result.capabilities.maxInputTokens).toBe(
			(result.capabilities.maxContextLength ?? 0) - (result.capabilities.maxOutputTokens ?? 0),
		);
	});

	it("keeps hosted pay-per-token Responses endpoints on the conservative thinking treatment", () => {
		const hosted = listed(
			profile({
				endpointName: "databricks-gpt-5-mini",
				task: "llm/v1/chat",
				servedEntities: [foundationEntity("databricks-gpt-5-mini")],
			}),
		);
		const external = listed(
			profile({
				endpointName: "my-gpt-5-route",
				servedEntities: [externalEntity("openai", "gpt-5-mini")],
			}),
		);

		expect(hosted.protocol).toBe("openai-responses");
		expect(hosted.capabilities.thinkingEffortLevels).toBeUndefined();
		expect(external.protocol).toBe("openai-responses");
		expect(external.capabilities.thinkingEffortLevels).toContain("high");
	});

	it("falls back to chat completions for OpenAI identities outside the allowlist", () => {
		for (const name of ["gpt-3.5-turbo", "gpt-4-turbo", "some-unknown-model"]) {
			expect(
				listed(
					profile({
						endpointName: `my-${name}`,
						servedEntities: [externalEntity("openai", name)],
					}),
				).protocol,
				name,
			).toBe("openai-chat");
		}
	});
});

describe("inferDatabricksModelProfile — Gemini family reconstructability", () => {
	it("routes a hosted Gemini endpoint natively with generateContent effort levels", () => {
		const result = listed(
			profile({
				endpointName: "databricks-gemini-2-5-pro",
				task: "llm/v1/chat",
				servedEntities: [foundationEntity("databricks-gemini-2-5-pro")],
			}),
		);

		expect(result.protocol).toBe("google-generative");
		expect(result.vendor).toBe("google");
		// 2.5 Pro cannot disable thinking, so "off" is not advertised.
		expect(result.capabilities.thinkingEffortLevels).toEqual(["low", "medium", "high"]);
	});

	it("falls back to chat completions when the endpoint name does not identify the variant", () => {
		const result = listed(
			profile({
				endpointName: "my-gemini-endpoint",
				servedEntities: [externalEntity("google-cloud-vertex-ai", "gemini-2.5-pro")],
			}),
		);

		expect(result.protocol).toBe("openai-chat");
		expect(result.capabilities.thinkingEffortLevels).toBeUndefined();
	});
});

describe("inferDatabricksModelProfile — gateway surface gating", () => {
	const claudeEndpoint = {
		surface: "gateway" as const,
		endpointName: "databricks-claude-opus-4-8",
	};

	it("stamps native only when every entity advertises the matching api_type", () => {
		expect(
			listed(
				profile({
					...claudeEndpoint,
					servedEntities: [
						foundationEntity("databricks-claude-opus-4-8", [GATEWAY_CHAT, ANTHROPIC_NATIVE]),
					],
				}),
			).protocol,
		).toBe("anthropic-messages");

		// Native family identity, but the gateway does not advertise the native API.
		expect(
			listed(
				profile({
					...claudeEndpoint,
					servedEntities: [foundationEntity("databricks-claude-opus-4-8", [GATEWAY_CHAT])],
				}),
			).protocol,
		).toBe("openai-chat");

		// One of two entities advertises it — not enough.
		expect(
			listed(
				profile({
					...claudeEndpoint,
					servedEntities: [
						foundationEntity("databricks-claude-opus-4-8", [GATEWAY_CHAT, ANTHROPIC_NATIVE]),
						foundationEntity("databricks-claude-sonnet-4-6", [GATEWAY_CHAT]),
					],
				}),
			).protocol,
		).toBe("openai-chat");
	});

	it("keeps native stamping ungated on the serving surface", () => {
		expect(
			listed(
				profile({
					endpointName: "databricks-claude-opus-4-8",
					task: "llm/v1/chat",
					servedEntities: [foundationEntity("databricks-claude-opus-4-8")],
				}),
			).protocol,
		).toBe("anthropic-messages");
	});
});

describe("inferDatabricksModelProfile — gateway chat availability", () => {
	it("excludes an endpoint whose entities cannot all serve gateway chat", () => {
		// Mixed set: one gateway-v2 chat entity, one without gateway v2 support.
		expect(
			profile({
				surface: "gateway",
				endpointName: "mixed-gateway-endpoint",
				servedEntities: [
					foundationEntity("databricks-llama-4-maverick", [GATEWAY_CHAT]),
					foundationEntity("legacy-model", [GATEWAY_CHAT], false),
				],
			}),
		).toEqual({ excluded: true });

		// Advertises no chat api_type at all.
		expect(
			profile({
				surface: "gateway",
				endpointName: "databricks-gte-large-en",
				servedEntities: [foundationEntity("databricks-gte-large-en", ["mlflow/v1/embeddings"])],
			}),
		).toEqual({ excluded: true });

		// No configured entities advertise anything.
		expect(profile({ surface: "gateway", endpointName: "empty" })).toEqual({ excluded: true });
	});

	it("never excludes on the serving surface, where chat completions is universal", () => {
		expect(listed(profile({ endpointName: "empty", servedEntities: [] })).protocol).toBe(
			"openai-chat",
		);
		expect(
			listed(
				profile({
					endpointName: "my-custom-chat-model",
					task: "llm/v1/chat",
					servedEntities: [{ entity_name: "main.models.my_custom_model" }],
				}),
			),
		).toMatchObject({ protocol: "openai-chat", vendor: "databricks" });
	});
});

describe("inferDatabricksModelProfile — multi-entity aggregation", () => {
	it("requires protocol unanimity across every configured entity", () => {
		expect(
			listed(
				profile({
					endpointName: "mixed-vendors",
					servedEntities: [
						foundationEntity("databricks-claude-opus-4-8"),
						externalEntity("openai", "gpt-4o"),
					],
				}),
			).protocol,
		).toBe("openai-chat");
	});

	it("merges same-protocol capabilities conservatively", () => {
		const result = listed(
			profile({
				endpointName: "databricks-claude-opus-4-8",
				task: "llm/v1/chat",
				servedEntities: [
					foundationEntity("databricks-claude-opus-4-8"),
					foundationEntity("databricks-claude-sonnet-4-6"),
				],
			}),
		);

		expect(result.protocol).toBe("anthropic-messages");
		// Minimum numeric limits: Sonnet 4.6 caps output at 64k, Opus 4.8 at 128k.
		expect(result.capabilities.maxOutputTokens).toBe(64_000);
		expect(result.capabilities.maxInputTokens).toBe(1_000_000 - 128_000);
		// Intersection of effort levels: Sonnet 4.6 has no "xhigh".
		expect(result.capabilities.thinkingEffortLevels).not.toContain("xhigh");
		expect(result.capabilities.thinkingEffortLevels).toContain("high");
		// `family` only when unanimous.
		expect(result.capabilities.family).toBeUndefined();
	});

	it("intersects an unrecognized entity down to the conservative baseline", () => {
		const result = listed(
			profile({
				endpointName: "claude-plus-unknown",
				servedEntities: [
					foundationEntity("databricks-claude-opus-4-8"),
					{ entity_name: "main.models.mystery" },
				],
			}),
		);

		expect(result.protocol).toBe("openai-chat");
		expect(result.capabilities.supportsImages).toBe(false);
		expect(result.capabilities.supportedInputMediaTypes).toBeUndefined();
		expect(result.capabilities.maxOutputTokens).toBe(16_384);
	});

	it("is invariant to served-entity order", () => {
		const entities: DatabricksServedEntityInput[] = [
			foundationEntity("databricks-claude-opus-4-8"),
			foundationEntity("databricks-claude-sonnet-4-6"),
			foundationEntity("databricks-claude-haiku-4-5"),
		];
		const forward = profile({
			endpointName: "databricks-claude-opus-4-8",
			task: "llm/v1/chat",
			servedEntities: entities,
		});
		const reversed = profile({
			endpointName: "databricks-claude-opus-4-8",
			task: "llm/v1/chat",
			servedEntities: [...entities].reverse(),
		});

		expect(reversed).toEqual(forward);
		expect(listed(forward).protocol).toBe("anthropic-messages");
	});
});

describe("inferDatabricksModelProfile — fallback stamping", () => {
	it("always stamps an explicit openai-chat protocol on every fallback path", () => {
		const fallbacks = [
			profile({ endpointName: "empty" }),
			profile({
				endpointName: "unknown",
				servedEntities: [{ entity_name: "main.models.unknown" }],
			}),
			profile({
				endpointName: "mixed",
				servedEntities: [
					foundationEntity("databricks-claude-opus-4-8"),
					externalEntity("openai", "gpt-4o"),
				],
			}),
			profile({
				surface: "gateway",
				endpointName: "databricks-llama-4-maverick",
				servedEntities: [foundationEntity("databricks-llama-4-maverick", [GATEWAY_CHAT])],
			}),
		];

		for (const fallback of fallbacks) {
			expect(listed(fallback).protocol).toBe("openai-chat");
		}
	});
});
