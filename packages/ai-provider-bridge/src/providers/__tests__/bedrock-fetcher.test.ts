/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMantleModels, listFoundationModels, listInferenceProfiles } = vi.hoisted(() => ({
	listMantleModels: vi.fn(),
	listFoundationModels: vi.fn(),
	listInferenceProfiles: vi.fn(),
}));

vi.mock("../bedrock-mantle-models", () => ({ listMantleModels }));
vi.mock("@aws-sdk/client-bedrock", () => ({
	BedrockClient: vi.fn(function () {
		return {
			send: (command: { __kind?: string }) =>
				command.__kind === "inference-profiles"
					? listInferenceProfiles(command)
					: listFoundationModels(command),
		};
	}),
	ListFoundationModelsCommand: vi.fn(function (this: { __kind: string }) {
		this.__kind = "foundation-models";
	}),
	ListInferenceProfilesCommand: vi.fn(function (this: { __kind: string }) {
		this.__kind = "inference-profiles";
	}),
}));

import type { Logger } from "../../types";
import { registerBedrockProvider } from "../bedrock-provider";
import { ProviderRegistry } from "../ProviderRegistry";

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

const CLAUDE_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

function inferenceProfile(profileId: string, modelId: string) {
	return {
		inferenceProfileName: profileId,
		inferenceProfileArn: `arn:aws:bedrock:us-east-1::inference-profile/${profileId}`,
		inferenceProfileId: profileId,
		status: "ACTIVE",
		models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
		type: "SYSTEM_DEFINED",
	};
}

function credentialsFor(region: string) {
	return {
		type: "aws-credentials" as const,
		region,
		accessKeyId: "key",
		secretAccessKey: "secret",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	listMantleModels.mockResolvedValue([
		{ id: "openai.gpt-oss-120b" },
		{ id: "openai.gpt-5.6-terra" },
		{ id: "openai.gpt-oss-safeguard-120b" },
		{ id: "openai.unknown-model" },
	]);
	listFoundationModels.mockResolvedValue({
		modelSummaries: [
			{
				modelId: CLAUDE_MODEL_ID,
				modelName: "Claude 3.5 Sonnet",
				responseStreamingSupported: true,
			},
			{
				// The Converse catalog can contain OpenAI IDs, but Mantle owns
				// them and must emit the exact non-prefixed inference ID once.
				modelId: "openai.gpt-oss-120b",
				modelName: "GPT OSS",
				responseStreamingSupported: true,
			},
		],
	});
	// Default: discovery succeeds and mirrors the legacy prefix-constructed ID.
	listInferenceProfiles.mockResolvedValue({
		inferenceProfileSummaries: [inferenceProfile(`us.${CLAUDE_MODEL_ID}`, CLAUDE_MODEL_ID)],
	});
});

describe("Bedrock provider Mantle aggregation", () => {
	it("maps supported Mantle families, filters duplicates, and caches sources independently", async () => {
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());
		const credentials = credentialsFor("us-east-2");

		const models = await registry.getModelsForProvider("bedrock", credentials);
		const gptOss = models.find((model) => model.id === "openai.gpt-oss-120b");
		const gpt5 = models.find((model) => model.id === "openai.gpt-5.6-terra");

		expect(gptOss).toMatchObject({
			protocol: "openai-chat",
			baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
		});
		expect(gpt5).toMatchObject({
			protocol: "openai-responses",
			baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
			supportsToolResultImages: true,
		});
		expect(models.some((model) => model.id.includes("safeguard"))).toBe(false);
		expect(models.some((model) => model.id === "openai.unknown-model")).toBe(false);
		expect(models.some((model) => model.id === "us.openai.gpt-oss-120b")).toBe(false);

		await registry.getModelsForProvider("bedrock", credentials);
		expect(listMantleModels).toHaveBeenCalledTimes(1);
		expect(listFoundationModels).toHaveBeenCalledTimes(1);
	});

	it("keeps Converse models when Mantle discovery returns no models", async () => {
		listMantleModels.mockResolvedValueOnce([]);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-2"));

		expect(models.some((model) => model.vendor === "anthropic")).toBe(true);
		expect(onProviderStatusChange).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "auth_error" }),
		);
	});

	it("starts independently stale discovery sources concurrently", async () => {
		let resolveMantle: ((value: Array<{ id: string }>) => void) | undefined;
		let resolveConverse: ((value: { modelSummaries: [] }) => void) | undefined;
		listMantleModels.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveMantle = resolve;
			}),
		);
		listFoundationModels.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveConverse = resolve;
			}),
		);
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const fetchPromise = registry.getModelsForProvider("bedrock", credentialsFor("us-east-2"));

		await vi.waitFor(() => {
			expect(listMantleModels).toHaveBeenCalledTimes(1);
			expect(listFoundationModels).toHaveBeenCalledTimes(1);
		});
		resolveMantle?.([]);
		resolveConverse?.({ modelSummaries: [] });
		await expect(fetchPromise).resolves.toEqual([]);
	});
});

describe("Bedrock inference profile discovery", () => {
	it("uses discovered profile IDs over prefix construction", async () => {
		listInferenceProfiles.mockResolvedValueOnce({
			inferenceProfileSummaries: [inferenceProfile(`global.${CLAUDE_MODEL_ID}`, CLAUDE_MODEL_ID)],
		});
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models.some((model) => model.id === `global.${CLAUDE_MODEL_ID}`)).toBe(true);
		expect(models.some((model) => model.id === `us.${CLAUDE_MODEL_ID}`)).toBe(false);
	});

	it("falls back to prefix-constructed IDs when discovery is unavailable", async () => {
		// Behavior-preservation contract: a denied/failed discovery in a handled
		// family must produce exactly today's IDs.
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models.some((model) => model.id === `us.${CLAUDE_MODEL_ID}`)).toBe(true);
	});

	it("does not fabricate a fallback ID for a foundation model without an ID", async () => {
		listMantleModels.mockResolvedValueOnce([]);
		listFoundationModels.mockResolvedValueOnce({
			modelSummaries: [
				{
					modelName: "Missing model ID",
					responseStreamingSupported: true,
				},
			],
		});
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "network_error" }),
		);
	});

	it("returns no Converse models when discovery is unavailable in an unhandled family", async () => {
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("ca-central-1"));

		// No fabricated `us.` IDs — and a discovery 403 is a degradation, not
		// an auth failure.
		expect(models.some((model) => model.id.includes(CLAUDE_MODEL_ID))).toBe(false);
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "auth_error" }),
		);
	});

	it("skips FM models absent from a successful profile map", async () => {
		// A successful listing is authoritative absence: guessing an ID for a
		// missing profile would fail at invoke time.
		listInferenceProfiles.mockResolvedValueOnce({ inferenceProfileSummaries: [] });
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models.some((model) => model.id.includes(CLAUDE_MODEL_ID))).toBe(false);
	});
});
