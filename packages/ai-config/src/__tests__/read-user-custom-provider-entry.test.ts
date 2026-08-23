/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdir } from "node:fs/promises";

import { describe, expect, it, onTestFinished } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import {
	NonCustomProviderIdError,
	readUserCustomProviderEntry,
} from "../node/read-user-custom-provider-entry.js";

async function configFixture() {
	const fixture = await createConfigFileFixture();
	onTestFinished(fixture.cleanup);
	return fixture;
}

describe("readUserCustomProviderEntry", () => {
	it("returns the exact strict user-layer entry without rewriting its JSONC", async () => {
		const fixture = await configFixture();
		const authored = `{
	// This comment and the unrelated provider must remain byte-for-byte intact.
	"version": 1,
	"providers": {
		"custom": {
			"mixed snowflake": {
				"type": "snowflake",
				"baseUrl": "https://private.example/cortex",
				"snowflake": {
					"account": "account-id",
					"host": "account.privatelink.snowflakecomputing.com",
					"home": "/managed/snowflake",
				},
				"customHeaders": { "authorization": "authored-value" },
			},
			"unrelated": { "type": "ollama", "endpoint": "http://localhost:11434" },
		},
	},
}
`;
		await fixture.writeRawJsonc(authored);

		await expect(
			readUserCustomProviderEntry("mixed snowflake", { configPath: fixture.configPath }),
		).resolves.toEqual({
			type: "snowflake",
			baseUrl: "https://private.example/cortex",
			snowflake: {
				account: "account-id",
				host: "account.privatelink.snowflakecomputing.com",
				home: "/managed/snowflake",
			},
			customHeaders: { authorization: "authored-value" },
		});
		expect(await fixture.readRaw()).toBe(authored);
		expect(await fixture.readBytes()).toEqual(Buffer.from(authored, "utf8"));
	});

	it("returns undefined for an absent user entry", async () => {
		const fixture = await configFixture();
		await fixture.writeTypedConfig({ version: 1, providers: { custom: {} } });

		await expect(
			readUserCustomProviderEntry("external gateway", { configPath: fixture.configPath }),
		).resolves.toBe(undefined);
	});

	it("returns undefined when providers.json is missing", async () => {
		const fixture = await configFixture();

		await expect(
			readUserCustomProviderEntry("external gateway", { configPath: fixture.configPath }),
		).resolves.toBe(undefined);
	});

	it("returns undefined for an absent prototype-named entry", async () => {
		const fixture = await configFixture();
		await fixture.writeTypedConfig({
			version: 1,
			providers: { custom: { unrelated: { type: "ollama" } } },
		});

		await expect(
			readUserCustomProviderEntry("constructor", { configPath: fixture.configPath }),
		).resolves.toBe(undefined);
	});

	it.each(["anthropic", "default", "__proto__"])(
		"rejects non-custom provider id %s with a typed error",
		async (providerId) => {
			await expect(readUserCustomProviderEntry(providerId)).rejects.toBeInstanceOf(
				NonCustomProviderIdError,
			);
		},
	);

	it.each([
		[
			"schema-invalid JSONC",
			'{ "version": 1, "providers": { "custom": { "gateway": { "type": "aws", "unexpected": true } } } }',
		],
		["malformed JSONC", '{ "version": 1, "providers": {'],
	] as const)("rejects %s instead of salvaging it", async (_case, raw) => {
		const fixture = await configFixture();
		await fixture.writeRawJsonc(raw);

		await expect(
			readUserCustomProviderEntry("gateway", { configPath: fixture.configPath }),
		).rejects.toThrow(/Fix the file before editing custom providers/);
	});

	it("rejects a directory at configPath as unreadable", async () => {
		const fixture = await configFixture();
		await mkdir(fixture.configPath);

		await expect(
			readUserCustomProviderEntry("gateway", { configPath: fixture.configPath }),
		).rejects.toThrow(/Cannot read/);
	});
});
