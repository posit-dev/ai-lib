/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPositAiProvider } from "../providers/positai-provider";
import { ProviderRegistry } from "../providers/ProviderRegistry";
import type { Logger, PositAiAuthMetadata } from "../types";
import { isAccountUnavailableBody, isAgreementRequiredBody, parsePositAiErrorBody } from "../utils";

const credentials = { type: "oauth" as const, accessToken: "test-token" };

function createLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

async function fetchMetadata(body: unknown): Promise<{
	metadata: PositAiAuthMetadata | undefined;
	logger: Logger;
}> {
	const logger = createLogger();
	const registry = new ProviderRegistry(logger);
	registerPositAiProvider(registry, "https://gateway.example.test", "test/1.0", logger);
	vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
		new Response(JSON.stringify(body), { status: 403 }),
	);

	await expect(registry.getModelsForProvider("positai", credentials)).resolves.toEqual([]);
	return {
		metadata: registry.getModelFetchState<PositAiAuthMetadata>("positai"),
		logger,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Posit AI structured error contract", () => {
	it("preserves precise agreement-required metadata and its safe correlation id", async () => {
		const { metadata, logger } = await fetchMetadata({
			error_type: "agreement_required",
			error_id: "req_01J.TEST-42",
			message: "internal detail is not retained",
		});

		expect(metadata).toEqual({
			modelFetchState: "agreement_required",
			modelFetchStatusCode: 403,
			modelFetchErrorType: "agreement_required",
			modelFetchErrorId: "req_01J.TEST-42",
		});
		expect(logger.warn).toHaveBeenCalledWith(
			"[positai] Models endpoint returned 403 (agreement_required); returning no Posit AI models",
		);
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("internal detail");
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("using fallback");
	});

	it("preserves the neutral account-not-found state from a nested error", async () => {
		const { metadata } = await fetchMetadata({
			error: { error_type: "account_not_found", error_id: "support-123" },
		});

		expect(metadata).toEqual({
			modelFetchState: "account_not_found",
			modelFetchStatusCode: 403,
			modelFetchErrorType: "account_not_found",
			modelFetchErrorId: "support-123",
		});
	});

	it("retains the legacy producer state while exposing its exact raw type", async () => {
		const { metadata } = await fetchMetadata({
			error_type: "prism_account_not_found",
			error_id: "legacy-123",
		});

		expect(metadata).toEqual({
			modelFetchState: "agreement_pending",
			modelFetchStatusCode: 403,
			modelFetchErrorType: "prism_account_not_found",
			modelFetchErrorId: "legacy-123",
		});
	});

	it("keeps an unknown 403 on the ordinary error path", async () => {
		const { metadata } = await fetchMetadata({
			error_type: "access_forbidden",
			error_id: "support-403",
		});

		expect(metadata).toEqual({
			modelFetchState: "error",
			modelFetchStatusCode: 403,
			modelFetchErrorType: "access_forbidden",
			modelFetchErrorId: "support-403",
		});
	});

	it("drops unsafe error ids and never infers a signal from raw text", () => {
		expect(
			parsePositAiErrorBody(
				JSON.stringify({ error_type: "account_not_found", error_id: "Bearer secret-token" }),
			),
		).toEqual({ errorType: "account_not_found", errorId: undefined });
		expect(parsePositAiErrorBody("Forbidden: agreement_required")).toEqual({});
		expect(parsePositAiErrorBody(JSON.stringify({ error_type: "forbidden\ninternal" }))).toEqual({
			errorType: undefined,
			errorId: undefined,
		});
		expect(isAgreementRequiredBody("Forbidden: agreement_required")).toBe(false);
		expect(isAccountUnavailableBody("Forbidden: prism_account_not_found")).toBe(false);
	});

	it("classifies only the exact supported structured types", () => {
		expect(isAgreementRequiredBody(JSON.stringify({ error_type: "agreement_required" }))).toBe(
			true,
		);
		expect(isAgreementRequiredBody(JSON.stringify({ error_type: "prism_account_not_found" }))).toBe(
			false,
		);
		expect(isAccountUnavailableBody(JSON.stringify({ error_type: "account_not_found" }))).toBe(
			true,
		);
		expect(
			isAccountUnavailableBody(JSON.stringify({ error_type: "prism_account_not_found" })),
		).toBe(true);
	});
});
