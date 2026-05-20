/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared endpoint test logic for local providers (Ollama, LM Studio).
 *
 * Returns a structurally typed result — no shared type import needed.
 * Both standalone and Positron consume these functions.
 */

export async function testOllamaProvider(
	endpoint: string,
): Promise<{ success: true; modelCount: number } | { success: false; error: string }> {
	const apiUrl = endpoint.endsWith("/") ? `${endpoint}api/tags` : `${endpoint}/api/tags`;

	try {
		const response = await fetch(apiUrl, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
		}

		const responseData = (await response.json()) as { models?: unknown[] };
		return { success: true, modelCount: (responseData.models as unknown[])?.length || 0 };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

export async function testLMStudioProvider(
	endpoint: string,
): Promise<{ success: true; modelCount: number } | { success: false; error: string }> {
	const apiUrl = endpoint.endsWith("/") ? `${endpoint}v1/models` : `${endpoint}/v1/models`;

	try {
		const response = await fetch(apiUrl, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
		}

		const responseData = (await response.json()) as { data?: unknown[] };
		return { success: true, modelCount: (responseData.data as unknown[])?.length || 0 };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

export async function testOpenAICompatibleProvider(
	baseUrl: string,
	apiKey?: string,
): Promise<{ success: true; modelCount: number } | { success: false; error: string }> {
	const base = baseUrl.replace(/\/+$/, "");
	const apiUrl = new URL("models", base + "/").toString();

	try {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		const response = await fetch(apiUrl, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) {
			return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
		}

		const responseData = (await response.json()) as { data?: unknown[] };
		return { success: true, modelCount: (responseData.data as unknown[])?.length || 0 };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}

export async function testLocalProvider(
	providerId: string,
	endpoint: string,
): Promise<{ success: true; modelCount: number } | { success: false; error: string }> {
	if (providerId === "ollama") {
		return testOllamaProvider(endpoint);
	} else if (providerId === "lmstudio") {
		return testLMStudioProvider(endpoint);
	}
	return { success: false, error: "Provider test not implemented" };
}
