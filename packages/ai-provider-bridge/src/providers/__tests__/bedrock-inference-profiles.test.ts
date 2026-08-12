/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ListInferenceProfilesResponse } from "@aws-sdk/client-bedrock";
import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import {
	type InferenceProfileLister,
	listInferenceProfileIds,
} from "../bedrock-inference-profiles";

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

function profile(id: string, modelId: string, status = "ACTIVE") {
	return {
		inferenceProfileName: id,
		inferenceProfileArn: `arn:aws:bedrock:us-east-1::inference-profile/${id}`,
		inferenceProfileId: id,
		status,
		models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
		type: "SYSTEM_DEFINED",
	};
}

function lister(
	responses: ListInferenceProfilesResponse[] | ((call: number) => ListInferenceProfilesResponse),
): InferenceProfileLister & { calls: unknown[] } {
	const calls: unknown[] = [];
	let call = 0;
	return {
		calls,
		send: (command) => {
			calls.push(command.input);
			const response = typeof responses === "function" ? responses(call) : responses[call];
			call += 1;
			if (!response) {
				throw new Error(`unexpected call ${call}`);
			}
			return Promise.resolve(response);
		},
	};
}

describe("listInferenceProfileIds", () => {
	it("joins profile model ARNs to bare model IDs", async () => {
		const client = lister([
			{
				inferenceProfileSummaries: [
					profile(
						"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
						"anthropic.claude-sonnet-4-5-20250929-v1:0",
					),
				],
			},
		]);

		const map = await listInferenceProfileIds(client, "us", logger());

		expect(map?.get("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		);
	});

	it("joins AWS GovCloud partition ARNs to us-gov profile IDs", async () => {
		const modelId = "anthropic.claude-sonnet-4-5-20250929-v1:0";
		const profileId = `us-gov.${modelId}`;
		const client = lister([
			{
				inferenceProfileSummaries: [
					{
						inferenceProfileName: profileId,
						inferenceProfileArn: `arn:aws-us-gov:bedrock:us-gov-west-1::inference-profile/${profileId}`,
						inferenceProfileId: profileId,
						status: "ACTIVE",
						models: [
							{
								modelArn: `arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/${modelId}`,
							},
						],
						type: "SYSTEM_DEFINED",
					},
				],
			},
		]);

		const map = await listInferenceProfileIds(client, "us-gov", logger());

		expect(map?.get(modelId)).toBe(profileId);
	});

	it("selects profiles by total order, independent of response order", async () => {
		const summaries = [
			profile("global.anthropic.claude-x", "anthropic.claude-x"),
			profile("apac.anthropic.claude-x", "anthropic.claude-x"),
			profile("jp.anthropic.claude-x", "anthropic.claude-x"),
		];
		const forward = await listInferenceProfileIds(
			lister([{ inferenceProfileSummaries: summaries }]),
			"apac",
			logger(),
		);
		const reversed = await listInferenceProfileIds(
			lister([{ inferenceProfileSummaries: [...summaries].reverse() }]),
			"apac",
			logger(),
		);

		// Legacy-prefix match wins over other geo and global profiles.
		expect(forward?.get("anthropic.claude-x")).toBe("apac.anthropic.claude-x");
		expect(reversed?.get("anthropic.claude-x")).toBe("apac.anthropic.claude-x");
	});

	it("chooses among non-preferred geo profiles alphabetically, independent of response order", async () => {
		// With no preferred-prefix match, the alphabetically first non-global
		// profile must win in both orders — this is the branch whose
		// determinism the sort protects (a plain first-wins find would flip
		// the answer when the response order flips).
		const summaries = [
			profile("jp.anthropic.claude-y", "anthropic.claude-y"),
			profile("global.anthropic.claude-y", "anthropic.claude-y"),
			profile("eu.anthropic.claude-y", "anthropic.claude-y"),
		];
		const forward = await listInferenceProfileIds(
			lister([{ inferenceProfileSummaries: summaries }]),
			"apac", // matches no candidate
			logger(),
		);
		const reversed = await listInferenceProfileIds(
			lister([{ inferenceProfileSummaries: [...summaries].reverse() }]),
			"apac",
			logger(),
		);

		expect(forward?.get("anthropic.claude-y")).toBe("eu.anthropic.claude-y");
		expect(reversed?.get("anthropic.claude-y")).toBe("eu.anthropic.claude-y");
	});

	it("prefers other geo profiles over global, and uses global when it is the only mapping", async () => {
		const map = await listInferenceProfileIds(
			lister([
				{
					inferenceProfileSummaries: [
						profile("global.anthropic.claude-a", "anthropic.claude-a"),
						profile("eu.anthropic.claude-a", "anthropic.claude-a"),
						profile("global.anthropic.claude-b", "anthropic.claude-b"),
					],
				},
			]),
			"us", // matches neither candidate
			logger(),
		);

		expect(map?.get("anthropic.claude-a")).toBe("eu.anthropic.claude-a");
		expect(map?.get("anthropic.claude-b")).toBe("global.anthropic.claude-b");
	});

	it("follows nextToken across pages", async () => {
		const client = lister([
			{
				inferenceProfileSummaries: [profile("us.anthropic.claude-a", "anthropic.claude-a")],
				nextToken: "page-2",
			},
			{
				inferenceProfileSummaries: [profile("us.anthropic.claude-b", "anthropic.claude-b")],
			},
		]);

		const map = await listInferenceProfileIds(client, "us", logger());

		expect(client.calls).toHaveLength(2);
		// The second request must carry the page token — otherwise a regression
		// that drops it would re-request page one forever and still pass here.
		expect(client.calls[1]).toMatchObject({ nextToken: "page-2" });
		expect(map?.get("anthropic.claude-a")).toBe("us.anthropic.claude-a");
		expect(map?.get("anthropic.claude-b")).toBe("us.anthropic.claude-b");
	});

	it("excludes non-ACTIVE profiles and openai.* models", async () => {
		const map = await listInferenceProfileIds(
			lister([
				{
					inferenceProfileSummaries: [
						profile("us.anthropic.claude-a", "anthropic.claude-a", "CREATING"),
						profile("us.openai.gpt-oss-120b", "openai.gpt-oss-120b"),
					],
				},
			]),
			"us",
			logger(),
		);

		expect(map?.size).toBe(0);
	});

	it("returns null and logs at debug on AccessDenied, naming the IAM action", async () => {
		const log = logger();
		const error = Object.assign(new Error("denied"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403 },
		});
		const client: InferenceProfileLister = { send: () => Promise.reject(error) };

		const map = await listInferenceProfileIds(client, "us", log);

		expect(map).toBeNull();
		expect(log.debug).toHaveBeenCalledWith(
			expect.stringContaining("bedrock:ListInferenceProfiles"),
		);
		expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining("Falling back"));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("returns null and logs at warn with the error on other failures", async () => {
		const log = logger();
		const client: InferenceProfileLister = {
			send: () => Promise.reject(new Error("ThrottlingException: slow down")),
		};

		const map = await listInferenceProfileIds(client, "us", log);

		expect(map).toBeNull();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ThrottlingException"));
		expect(log.debug).not.toHaveBeenCalled();
	});
});
