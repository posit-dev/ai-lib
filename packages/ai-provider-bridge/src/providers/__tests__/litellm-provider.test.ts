/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { litellmV1BaseUrl, parseLitellmModelInfoResponse } from "../litellm-provider";

describe("litellmV1BaseUrl", () => {
	it("appends /v1 to a bare proxy address", () => {
		expect(litellmV1BaseUrl("http://localhost:4000")).toBe("http://localhost:4000/v1");
	});

	it("tolerates trailing slashes and an existing /v1 segment", () => {
		expect(litellmV1BaseUrl("http://localhost:4000/")).toBe("http://localhost:4000/v1");
		expect(litellmV1BaseUrl("http://localhost:4000/v1")).toBe("http://localhost:4000/v1");
		expect(litellmV1BaseUrl("http://localhost:4000/v1/")).toBe("http://localhost:4000/v1");
	});
});

describe("parseLitellmModelInfoResponse", () => {
	it("filters non-chat modes but keeps entries with unknown mode", () => {
		const models = parseLitellmModelInfoResponse({
			data: [
				{ model_name: "embedder", model_info: { mode: "embedding" } },
				{ model_name: "imagegen", model_info: { mode: "image_generation" } },
				{ model_name: "null-mode", model_info: { mode: null } },
				{ model_name: "no-info" },
			],
		});
		expect(models.map((m) => m.id)).toEqual(["null-mode", "no-info"]);
	});

	it("skips entries without a model_name", () => {
		const models = parseLitellmModelInfoResponse({
			data: [{ model_info: { mode: "chat" } }, { model_name: "ok" }],
		});
		expect(models.map((m) => m.id)).toEqual(["ok"]);
	});

	it("returns no models for an empty or shapeless response", () => {
		expect(parseLitellmModelInfoResponse({})).toEqual([]);
		expect(parseLitellmModelInfoResponse({ data: [] })).toEqual([]);
	});

	it("gives Claude aliases full Anthropic capabilities from the underlying model id", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "my-sonnet",
					litellm_params: { model: "anthropic/claude-sonnet-5-20251101" },
					model_info: { litellm_provider: "anthropic", mode: "chat" },
				},
			],
		});
		expect(model.id).toBe("my-sonnet");
		expect(model.vendor).toBe("anthropic");
		expect(model.thinkingEffortLevels).toContain("high");
		expect(model.maxContextLength).toBe(1_000_000);
		expect(model.supportsImages).toBe(true);
		expect(model.supportsWebSearch).toBe(false);
	});

	it("detects Claude behind Bedrock inference-profile ids", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "bedrock-sonnet",
					litellm_params: { model: "bedrock/us.anthropic.claude-sonnet-4-6-20251001-v1:0" },
					model_info: { litellm_provider: "bedrock_converse", mode: "chat" },
				},
			],
		});
		expect(model.vendor).toBe("anthropic");
		expect(model.thinkingEffortLevels).toBeDefined();
	});

	it("detects Claude from the alias when litellm_params is missing", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [{ model_name: "claude-haiku-4-5" }],
		});
		expect(model.vendor).toBe("anthropic");
		expect(model.maxOutputTokens).toBe(64_000);
	});

	it("maps non-Claude metadata without offering thinking levels", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "gpt-5-mini",
					litellm_params: { model: "openai/gpt-5-mini" },
					model_info: {
						litellm_provider: "openai",
						mode: "chat",
						max_input_tokens: 272_000,
						max_output_tokens: 128_000,
						supports_vision: true,
					},
				},
			],
		});
		expect(model.vendor).toBe("openai");
		expect(model.thinkingEffortLevels).toBeUndefined();
		expect(model.maxInputTokens).toBe(272_000);
		expect(model.maxOutputTokens).toBe(128_000);
		expect(model.supportsImages).toBe(true);
	});

	it("falls back to conservative defaults when model_info is all null (Ollama-style)", () => {
		const [model] = parseLitellmModelInfoResponse({
			data: [
				{
					model_name: "qwen3-coder",
					litellm_params: { model: "ollama_chat/qwen3-coder:30b" },
					model_info: {
						litellm_provider: null,
						mode: null,
						max_input_tokens: null,
						max_output_tokens: null,
						supports_vision: null,
					},
				},
			],
		});
		expect(model.vendor).toBe("litellm");
		expect(model.maxInputTokens).toBe(128_000);
		expect(model.maxOutputTokens).toBe(16_384);
		expect(model.supportsImages).toBe(false);
		expect(model.thinkingEffortLevels).toBeUndefined();
	});
});
