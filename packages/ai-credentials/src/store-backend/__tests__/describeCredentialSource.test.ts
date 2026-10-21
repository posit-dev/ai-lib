/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * `describeCredentialSource` explains the store backend's own store → env
 * decision without secrets and without side effects, and agrees with
 * `getCredentials` on whether a credential is supplied.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createSingleFileStoreFixture,
	type SingleFileStoreFixture,
} from "../../../tests/helpers/single-file-store-fixture.js";
import { storageKeyFor } from "../../types/index.js";
import type { AuthMethodDescriptor } from "../StoreBackend.js";
import { createStoreBackend } from "../StoreBackend.js";
import type { StoredProviderCredentials } from "../StoredProviderCredentials.js";

const STORED_SECRET = "sk-stored-SECRET-1";
const ENV_SECRET = "sk-env-SECRET-2";
const REFRESH_SECRET = "refresh-SECRET-3";

const DESCRIPTORS: Record<string, AuthMethodDescriptor> = {
	anthropic: { authMethodId: "apikey" },
	positai: { authMethodId: "oauth" },
};

function resolveAuthMethod(id: string): AuthMethodDescriptor | undefined {
	return DESCRIPTORS[id];
}

describe("describeCredentialSource", () => {
	let fixture: SingleFileStoreFixture;

	beforeEach(() => {
		fixture = createSingleFileStoreFixture("aicred-describe-");
	});

	afterEach(() => {
		fixture.cleanup();
		vi.unstubAllEnvs();
	});

	it("reports the stored key as used and the environment as not consulted", async () => {
		await fixture.store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
			apiKeyAuth: { apiKey: STORED_SECRET },
		});
		const backend = createStoreBackend({
			store: fixture.store,
			resolveAuthMethod,
			env: { ANTHROPIC_API_KEY: ENV_SECRET },
		});

		const description = await backend.describeCredentialSource("anthropic");

		expect(description).toEqual({
			supplies: true,
			steps: [
				{
					kind: "stored",
					location: fixture.filePath,
					credentialType: "api-key",
					readiness: "ready",
					expiresAt: null,
					outcome: "used",
					reason: "supplies",
				},
				{
					kind: "environment",
					variables: [{ name: "ANTHROPIC_API_KEY", set: true }],
					outcome: "not-consulted",
					reason: "stored-checked-first",
				},
			],
		});
		expect(JSON.stringify(description)).not.toContain(STORED_SECRET);
		expect(JSON.stringify(description)).not.toContain(ENV_SECRET);
	});

	it("reads presence from the captured environment, not process.env", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		const captured = createStoreBackend({
			store: fixture.store,
			resolveAuthMethod,
			env: { ANTHROPIC_API_KEY: ENV_SECRET },
		});
		const captureDescription = await captured.describeCredentialSource("anthropic");
		expect(captureDescription.supplies).toBe(true);
		expect(captureDescription.steps[1]).toMatchObject({
			variables: [{ name: "ANTHROPIC_API_KEY", set: true }],
			outcome: "used",
		});
		expect(JSON.stringify(captureDescription)).not.toContain(ENV_SECRET);

		vi.stubEnv("ANTHROPIC_API_KEY", ENV_SECRET);
		const scrubbed = createStoreBackend({ store: fixture.store, resolveAuthMethod, env: {} });
		const scrubbedDescription = await scrubbed.describeCredentialSource("anthropic");
		expect(scrubbedDescription.supplies).toBe(false);
		expect(scrubbedDescription.steps[1]).toMatchObject({
			variables: [{ name: "ANTHROPIC_API_KEY", set: false }],
			outcome: "not-used",
			reason: "no-variables-set",
		});
	});

	it("ends the lookup at a stored key the provider refuses, as getCredentials does", async () => {
		await fixture.store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
			apiKeyAuth: { apiKey: STORED_SECRET },
		});
		const backend = createStoreBackend({
			store: fixture.store,
			resolveAuthMethod,
			ignoresStoredApiKey: () => true,
			env: { ANTHROPIC_API_KEY: ENV_SECRET },
		});

		const description = await backend.describeCredentialSource("anthropic");
		expect(description.supplies).toBe(false);
		expect(await backend.getCredentials("anthropic")).toBeNull();
		expect(description.steps.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
			{ outcome: "not-used", reason: "stored-key-ignored" },
			{ outcome: "not-consulted", reason: "earlier-step-decided" },
		]);
	});

	it("falls through an empty stored key to the environment, as getCredentials does", async () => {
		await fixture.store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
			apiKeyAuth: { apiKey: "" },
		});
		const backend = createStoreBackend({
			store: fixture.store,
			resolveAuthMethod,
			env: { ANTHROPIC_API_KEY: ENV_SECRET },
		});

		const description = await backend.describeCredentialSource("anthropic");
		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: ENV_SECRET,
		});
		expect(description.supplies).toBe(true);
		expect(description.steps.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
			{ outcome: "not-used", reason: "stored-key-empty" },
			{ outcome: "used", reason: "supplies" },
		]);
	});

	it("describes a stored sign-in without refreshing, resolving a grant, or writing", async () => {
		const expiredAt = "2020-01-01T00:00:00.000Z";
		await fixture.store.set<StoredProviderCredentials>(storageKeyFor("positai", "oauth"), {
			readiness: "ready",
			source: "oauth-device",
			oauthAuth: {
				tokenData: {
					accessToken: "access-SECRET-4",
					refreshToken: REFRESH_SECRET,
					expiresAt: expiredAt,
					tokenType: "Bearer",
					scope: "prism",
				},
			},
		});
		const before = fixture.readBytes();
		const oauthConfigForProvider = vi.fn(() => undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const set = vi.spyOn(fixture.store, "set");
		const backend = createStoreBackend({
			store: fixture.store,
			resolveAuthMethod,
			oauthConfigForProvider,
			env: {},
		});

		const description = await backend.describeCredentialSource("positai");

		expect(description.supplies).toBe(true);
		expect(description.steps[0]).toMatchObject({
			credentialType: "oauth",
			readiness: "ready",
			expiresAt: expiredAt,
			outcome: "used",
		});
		expect(description.steps[1]).toMatchObject({
			variables: [],
			outcome: "not-consulted",
		});
		expect(oauthConfigForProvider).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(set).not.toHaveBeenCalled();
		expect(fixture.readBytes().equals(before)).toBe(true);
		expect(JSON.stringify(description)).not.toContain("SECRET");
		fetchSpy.mockRestore();
	});

	it("reports a signed-out stored sign-in as final", async () => {
		await fixture.store.set<StoredProviderCredentials>(storageKeyFor("positai", "oauth"), {
			readiness: "unauthenticated",
			source: "oauth-device",
			error: "refresh_failed",
		});
		const backend = createStoreBackend({ store: fixture.store, resolveAuthMethod, env: {} });

		const description = await backend.describeCredentialSource("positai");
		expect(description.supplies).toBe(false);
		expect(description.steps[0]).toMatchObject({
			readiness: "unauthenticated",
			outcome: "not-used",
			reason: "stored-signed-out",
		});
	});
});
