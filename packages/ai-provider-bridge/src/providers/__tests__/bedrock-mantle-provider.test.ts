/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMantleModels, listFoundationModels } = vi.hoisted(() => ({
	listMantleModels: vi.fn(),
	listFoundationModels: vi.fn(),
}));

vi.mock("../bedrock-mantle-models", () => ({ listMantleModels }));
vi.mock("@aws-sdk/client-bedrock", () => ({
	BedrockClient: vi.fn(function () {
		return { send: listFoundationModels };
	}),
	ListFoundationModelsCommand: vi.fn(function () {}),
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
				modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
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
});

describe("Bedrock provider Mantle aggregation", () => {
	it("maps supported Mantle families, filters duplicates, and caches sources independently", async () => {
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());
		const credentials = {
			type: "aws-credentials" as const,
			region: "us-east-2",
			accessKeyId: "key",
			secretAccessKey: "secret",
		};

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

		const models = await registry.getModelsForProvider("bedrock", {
			type: "aws-credentials",
			region: "us-east-2",
			accessKeyId: "key",
			secretAccessKey: "secret",
		});

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

		const fetchPromise = registry.getModelsForProvider("bedrock", {
			type: "aws-credentials",
			region: "us-east-2",
			accessKeyId: "key",
			secretAccessKey: "secret",
		});

		await vi.waitFor(() => {
			expect(listMantleModels).toHaveBeenCalledTimes(1);
			expect(listFoundationModels).toHaveBeenCalledTimes(1);
		});
		resolveMantle?.([]);
		resolveConverse?.({ modelSummaries: [] });
		await expect(fetchPromise).resolves.toEqual([]);
	});
});
