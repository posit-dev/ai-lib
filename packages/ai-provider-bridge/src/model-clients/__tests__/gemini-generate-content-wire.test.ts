/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * `GeminiGenerateContentClient` wire behavior: auth scheme, full-history
 * sending, the `thoughtSignature` sanitizer, and the thinking mapping
 * mechanism.
 *
 * The variant profile comes from ai-config; here it is stubbed so these tests
 * exercise the client's *mapping mechanism* (budget vs level, off-ability,
 * clamping) independently of the profile table's data. Real per-variant
 * profiles are covered in `gemini-generate-content-variants.test.ts`.
 */

import type { ModelMessage } from "ai";
import type { GeminiGenerateContentProfile } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getGeminiGenerateContentProfile } = vi.hoisted(() => ({
	getGeminiGenerateContentProfile: vi.fn(),
}));

vi.mock("ai-config", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getGeminiGenerateContentProfile,
}));

import type { CancellationToken } from "../../types";
import { GeminiGenerateContentClient } from "../GeminiGenerateContentClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const PRO_2_5: GeminiGenerateContentProfile = {
	variant: "2.5-pro",
	thinking: {
		control: "budget",
		canDisable: false,
		budgets: { low: 2048, medium: 8192, high: 32_768 },
	},
	thinkingEffortLevels: ["low", "medium", "high"],
};

const FLASH_2_5: GeminiGenerateContentProfile = {
	variant: "2.5-flash",
	thinking: {
		control: "budget",
		canDisable: true,
		budgets: { low: 2048, medium: 8192, high: 24_576 },
	},
	thinkingEffortLevels: ["off", "low", "medium", "high"],
};

const FLASH_3: GeminiGenerateContentProfile = {
	variant: "3-flash",
	thinking: { control: "level", levels: ["minimal", "low", "medium", "high"] },
	thinkingEffortLevels: ["minimal", "low", "medium", "high"],
};

const PRO_3: GeminiGenerateContentProfile = {
	variant: "3-pro",
	thinking: { control: "level", levels: ["low", "high"] },
	thinkingEffortLevels: ["low", "high"],
};

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: {
		contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
		generationConfig?: {
			thinkingConfig?: {
				thinkingBudget?: number;
				thinkingLevel?: string;
				includeThoughts?: boolean;
			};
		};
		[key: string]: unknown;
	};
}

/** Drive one chat request through a stubbed fetch and return what was sent. */
async function capture(
	client: GeminiGenerateContentClient,
	overrides: {
		model?: string;
		messages?: ModelMessage[];
		thinkingEffort?: string;
	} = {},
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = {
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			};
			return new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
	);

	try {
		const stream = await client.chat({
			model: overrides.model ?? "gemini-2.5-pro",
			messages: overrides.messages ?? [{ role: "user", content: "hello" }],
			thinkingEffort: overrides.thinkingEffort,
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; stream errors are fine — we only care
		// about the serialized request.
	}

	if (!captured) throw new Error("no request was made");
	return captured;
}

beforeEach(() => {
	getGeminiGenerateContentProfile.mockReturnValue(PRO_2_5);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("GeminiGenerateContentClient auth", () => {
	it("sends Bearer exactly once and no x-goog-api-key for { authToken }", async () => {
		const { headers } = await capture(
			new GeminiGenerateContentClient({ authToken: "dapi-token" }, "https://host/gemini/v1beta"),
		);

		expect(headers.get("authorization")).toBe("Bearer dapi-token");
		// A duplicated header would surface as a comma-joined value.
		expect(headers.get("authorization")).not.toContain(",");
		expect(headers.has("x-goog-api-key")).toBe(false);
	});

	it("preserves additive non-auth custom headers under Bearer auth", async () => {
		const { headers } = await capture(
			new GeminiGenerateContentClient({ authToken: "dapi-token" }, "https://host/gemini/v1beta", {
				"x-tenant": "acme",
			}),
		);

		expect(headers.get("x-tenant")).toBe("acme");
		expect(headers.get("authorization")).toBe("Bearer dapi-token");
	});

	it("uses the SDK's native x-goog-api-key scheme for { apiKey }", async () => {
		const { headers } = await capture(
			new GeminiGenerateContentClient({ apiKey: "goog-key" }, undefined, { "x-tenant": "acme" }),
		);

		expect(headers.get("x-goog-api-key")).toBe("goog-key");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-tenant")).toBe("acme");
	});
});

describe("GeminiGenerateContentClient routing", () => {
	it("targets the generateContent surface, not interactions", async () => {
		const { url } = await capture(
			new GeminiGenerateContentClient({ apiKey: "goog-key" }, "https://host/gemini/v1beta"),
		);

		expect(url).toContain("https://host/gemini/v1beta/models/gemini-2.5-pro:");
		expect(url).toContain("streamGenerateContent");
		expect(url).not.toContain("interactions");
	});

	it("prefers the per-request base URL over the constructor value", async () => {
		const { url } = await capture(
			new GeminiGenerateContentClient({ apiKey: "goog-key" }, "https://ctor.example/v1beta"),
		);
		expect(url).toContain("https://ctor.example/v1beta/");

		// Same client, per-request override.
		let requestUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				requestUrl = String(input);
				return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);
		const client = new GeminiGenerateContentClient(
			{ apiKey: "goog-key" },
			"https://ctor.example/v1beta",
		);
		try {
			const stream = await client.chat({
				model: "gemini-2.5-pro",
				messages: [{ role: "user", content: "hello" }],
				baseUrl: "https://per-request.example/v1beta",
				cancellationToken,
			});
			for await (const _part of stream) {
				// drain
			}
		} catch {
			// stream errors are irrelevant here
		}
		expect(requestUrl).toContain("https://per-request.example/v1beta/");
	});

	it("throws a model-naming error when no variant profile resolves", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(undefined);

		await expect(
			new GeminiGenerateContentClient({ apiKey: "goog-key" }).chat({
				model: "mystery-endpoint",
				messages: [{ role: "user", content: "hello" }],
				cancellationToken,
			}),
		).rejects.toThrow(/mystery-endpoint/);
	});
});

describe("GeminiGenerateContentClient history", () => {
	/** Multi-turn history carrying Interactions-style metadata. */
	function chainedHistory(): ModelMessage[] {
		return [
			{ role: "user", content: "first question" },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				providerOptions: { google: { interactionId: "interactions/abc" } },
			},
			{ role: "user", content: "second question" },
		];
	}

	it("always sends full local history and never chains interaction IDs", async () => {
		const { body } = await capture(new GeminiGenerateContentClient({ apiKey: "goog-key" }), {
			messages: chainedHistory(),
		});

		expect(body.contents?.map((c) => c.role)).toEqual(["user", "model", "user"]);
		// generateContent is stateless: no Interactions-only fields on the wire.
		expect(body).not.toHaveProperty("store");
		expect(body).not.toHaveProperty("previousInteractionId");
		expect(JSON.stringify(body)).not.toContain("interactions/abc");
	});

	it("keeps signed reasoning, drops unsigned reasoning, preserves signed tool calls", async () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "think then act" },
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						text: "signed thought",
						providerOptions: { google: { thoughtSignature: "sig-1" } },
					},
					{ type: "reasoning", text: "unsigned thought" },
					{
						// Interactions-style signature is not a generateContent signature.
						type: "reasoning",
						text: "interactions-signed thought",
						providerOptions: { google: { signature: "int-sig" } },
					},
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "lookup",
						input: { q: "x" },
						providerOptions: { google: { thoughtSignature: "tool-sig" } },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "lookup",
						output: { type: "text", value: "y" },
					},
				],
			},
		];

		const { body } = await capture(new GeminiGenerateContentClient({ apiKey: "goog-key" }), {
			messages,
		});

		const modelParts = body.contents?.find((c) => c.role === "model")?.parts ?? [];
		const thoughts = modelParts.filter((part) => part.thought === true);
		expect(thoughts).toEqual([
			{ text: "signed thought", thought: true, thoughtSignature: "sig-1" },
		]);

		const toolCalls = modelParts.filter((part) => "functionCall" in part);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].thoughtSignature).toBe("tool-sig");
	});

	it("drops an assistant message whose only content was unsigned reasoning", async () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "one" },
			{ role: "assistant", content: [{ type: "reasoning", text: "unsigned" }] },
			{ role: "user", content: "two" },
		];

		const { body } = await capture(new GeminiGenerateContentClient({ apiKey: "goog-key" }), {
			messages,
		});

		expect(body.contents?.map((c) => c.role)).toEqual(["user", "user"]);
	});
});

describe("GeminiGenerateContentClient thinking mapping", () => {
	const thinkingConfig = (request: CapturedRequest) =>
		request.body.generationConfig?.thinkingConfig;

	it("maps effort onto the profile's budget and requests thought summaries", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(PRO_2_5);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			thinkingEffort: "high",
		});

		expect(thinkingConfig(request)).toEqual({ thinkingBudget: 32_768, includeThoughts: true });
	});

	it("clamps an unrecognized effort to medium", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(PRO_2_5);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			thinkingEffort: "ludicrous",
		});

		expect(thinkingConfig(request)?.thinkingBudget).toBe(8192);
	});

	it("sends thinkingBudget 0 for 'off' when the variant can disable thinking", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(FLASH_2_5);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			thinkingEffort: "off",
		});

		expect(thinkingConfig(request)).toEqual({ thinkingBudget: 0 });
	});

	it("omits thinkingConfig entirely for 'off' when the variant cannot disable thinking", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(PRO_2_5);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			thinkingEffort: "off",
		});

		expect(thinkingConfig(request)).toBeUndefined();
	});

	it("leaves the budget to the model default when no effort is requested", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(PRO_2_5);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }));

		expect(thinkingConfig(request)).toEqual({ includeThoughts: true });
	});

	it("sends thinkingLevel for level-controlled variants", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(FLASH_3);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			model: "gemini-3-flash-preview",
			thinkingEffort: "minimal",
		});

		expect(thinkingConfig(request)).toEqual({ thinkingLevel: "minimal", includeThoughts: true });
	});

	it("clamps a level the variant does not support into its supported set", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(PRO_3);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			model: "gemini-3-pro-preview",
			// "medium" is not in this variant's level set, and neither is the
			// usual fallback — so it lands on the lowest supported level.
			thinkingEffort: "medium",
		});

		expect(thinkingConfig(request)?.thinkingLevel).toBe("low");
	});

	it("omits thinkingConfig for 'off' on level-controlled variants (not representable)", async () => {
		getGeminiGenerateContentProfile.mockReturnValue(FLASH_3);
		const request = await capture(new GeminiGenerateContentClient({ apiKey: "k" }), {
			model: "gemini-3-flash-preview",
			thinkingEffort: "off",
		});

		expect(thinkingConfig(request)).toBeUndefined();
	});
});
