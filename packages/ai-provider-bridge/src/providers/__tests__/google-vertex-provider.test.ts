/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	getEffectiveLocation,
	isVertexAnthropicModel,
} from "../../model-clients/GoogleVertexClient";
import type { Logger } from "../../types";
import {
	registerCustomGoogleVertexProvider,
	registerGoogleVertexProvider,
} from "../google-vertex-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("registerGoogleVertexProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response("Request had invalid authentication credentials", {
					status: 401,
					statusText: "Unauthorized",
				});
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses Positron auth guidance for brokered-token auth errors", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(registry, mockLogger, { onProviderStatusChange });

		const models = await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "brokered-token",
		});

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith({
			providerId: "google-vertex",
			authMethodId: "google-cloud",
			status: "auth_error",
			error: {
				code: "google_cloud_auth_expired",
				message:
					"Google Cloud authentication expired or is unavailable. Reconnect Google Cloud auth in Positron, then click Refresh Models.",
				action: {
					label: "Refresh Models",
					commandId: "refresh-models",
				},
			},
		});
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining("Reconnect Google Cloud auth in Positron"),
		);
	});

	it("discovers models under a custom Vertex provider ID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				const publisherModels = url.includes("/google/")
					? [{ name: "publishers/google/models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }]
					: [
							{
								name: "publishers/anthropic/models/claude-sonnet-4-6",
								displayName: "Claude Sonnet 4.6",
							},
						];
				return new Response(JSON.stringify({ publisherModels }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const registry = new ProviderRegistry(mockLogger);
		const providerId = mintCustomProviderId("custom-vertex");
		registerCustomGoogleVertexProvider(registry, providerId, mockLogger);

		const models = await registry.getModelsForProvider(providerId, {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "brokered-token",
		});

		expect(models).toHaveLength(2);
		expect(models.every((model) => model.providerId === providerId)).toBe(true);
	});

	it("attributes custom Vertex authentication failures to the custom provider", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		const providerId = mintCustomProviderId("custom-vertex");
		registerCustomGoogleVertexProvider(registry, providerId, mockLogger, {
			onProviderStatusChange,
		});

		const models = await registry.getModelsForProvider(providerId, {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "expired-token",
		});

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({ providerId, status: "auth_error" }),
		);
	});
});

describe("GoogleVertexClient location heuristic", () => {
	it("routes recognized Anthropic model IDs to global via model-ID heuristic", () => {
		// Baseline: recognized model IDs already go to global
		expect(isVertexAnthropicModel("claude-sonnet-4-6")).toBe(true);
		expect(getEffectiveLocation("claude-sonnet-4-6", "us-central1")).toBe("global");
	});

	it("routes unrecognized model IDs to configured location", () => {
		// A model ID that doesn't match the anthropic pattern
		expect(isVertexAnthropicModel("my-custom-model")).toBe(false);
		expect(getEffectiveLocation("my-custom-model", "us-central1")).toBe("us-central1");
	});

	// The actual location-with-protocol behavior is tested indirectly:
	// GoogleVertexClient.createModel is private, so we verify the exported
	// helpers produce the right inputs and trust that createModel's
	// `useAnthropicApi && protocol === "anthropic-messages"` → "global" branch
	// is covered by the type-checked implementation.
});
