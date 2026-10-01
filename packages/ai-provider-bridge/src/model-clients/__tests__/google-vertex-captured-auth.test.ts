/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createVertex: vi.fn(() => vi.fn(() => ({}))),
	createVertexAnthropic: vi.fn(() => vi.fn(() => ({}))),
	streamText: vi.fn(() => ({
		fullStream: (async function* () {})(),
	})),
}));

vi.mock("@ai-sdk/google-vertex", () => ({ createVertex: mocks.createVertex }));
vi.mock("@ai-sdk/google-vertex/anthropic", () => ({
	createVertexAnthropic: mocks.createVertexAnthropic,
}));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: mocks.streamText,
}));

import { registerGoogleVertexProvider } from "../../providers/google-vertex-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type { Logger } from "../../types";
import { GoogleVertexClient } from "../GoogleVertexClient";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("GoogleVertexClient captured authentication", () => {
	it("passes the captured ADC filename to the lazily-created request SDK", async () => {
		const client = new GoogleVertexClient({
			project: "project-id",
			location: "us-central1",
			credentialSource: { kind: "adc", keyFilename: "/secrets/service-account.json" },
		});

		await client.chat({
			model: "gemini-2.5-pro",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			cancellationToken: {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} }),
			},
		});

		expect(mocks.createVertex).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "project-id",
				googleAuthOptions: { keyFilename: "/secrets/service-account.json" },
			}),
		);
	});

	it("threads the captured raw environment through the registered client factory", async () => {
		// The full lazy path a post-scrub chat request takes: captured raw
		// record → registered client factory → typed SDK reader → request SDK.
		const captured = Object.freeze({
			GOOGLE_APPLICATION_CREDENTIALS: "/secrets/service-account.json",
		});
		const registry = new ProviderRegistry(logger);
		registerGoogleVertexProvider(registry, logger, undefined, captured);

		const client = registry.getClientForProvider("google-vertex", {
			type: "google-cloud",
			project: "project-id",
			location: "us-central1",
		});
		if (!client) throw new Error("google-vertex client factory was not registered");
		await client.chat({
			model: "gemini-2.5-pro",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			cancellationToken: {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} }),
			},
		});

		expect(mocks.createVertex).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "project-id",
				googleAuthOptions: { keyFilename: "/secrets/service-account.json" },
			}),
		);
	});

	it("authenticates Gemini and Anthropic requests with a captured inline service account", async () => {
		const captured = Object.freeze({
			GOOGLE_CLIENT_EMAIL: "sa@project-id.iam.gserviceaccount.com",
			GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
		});
		const registry = new ProviderRegistry(logger);
		registerGoogleVertexProvider(registry, logger, undefined, captured);
		const client = registry.getClientForProvider("google-vertex", {
			type: "google-cloud",
			project: "project-id",
			location: "us-central1",
		});
		if (!client) throw new Error("google-vertex client factory was not registered");
		const cancellationToken = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		};
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
		];

		await client.chat({ model: "gemini-2.5-pro", messages, cancellationToken });
		await client.chat({
			model: "claude-sonnet-4-5",
			protocol: "anthropic-messages",
			messages,
			cancellationToken,
		});

		const expectedAuth = {
			googleAuthOptions: {
				credentials: {
					client_email: "sa@project-id.iam.gserviceaccount.com",
					private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				},
				scopes: ["https://www.googleapis.com/auth/cloud-platform"],
			},
		};
		expect(mocks.createVertex).toHaveBeenLastCalledWith(expect.objectContaining(expectedAuth));
		expect(mocks.createVertexAnthropic).toHaveBeenLastCalledWith(
			expect.objectContaining(expectedAuth),
		);
	});

	it("authenticates with a brokered token even when inline service-account variables are captured", async () => {
		const captured = Object.freeze({
			GOOGLE_CLIENT_EMAIL: "sa@project-id.iam.gserviceaccount.com",
			GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
		});
		const registry = new ProviderRegistry(logger);
		registerGoogleVertexProvider(registry, logger, undefined, captured);
		const client = registry.getClientForProvider("google-vertex", {
			type: "google-cloud",
			project: "project-id",
			location: "us-central1",
			accessToken: "brokered-token",
		});
		if (!client) throw new Error("google-vertex client factory was not registered");

		await client.chat({
			model: "gemini-2.5-pro",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			cancellationToken: {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} }),
			},
		});

		expect(mocks.createVertex).toHaveBeenLastCalledWith(
			expect.objectContaining({ googleAuthOptions: { authClient: expect.anything() } }),
		);
	});
});
