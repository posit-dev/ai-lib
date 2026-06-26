/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import { registerGoogleVertexProvider } from "../google-vertex-provider";
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
});
