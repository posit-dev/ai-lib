/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdir } from "node:fs/promises";

import { describe, expect, it, onTestFinished } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { readUserCustomProviderEntries } from "../node/read-user-custom-provider-entries.js";

async function configFixture() {
	const fixture = await createConfigFileFixture();
	onTestFinished(fixture.cleanup);
	return fixture;
}

describe("readUserCustomProviderEntries", () => {
	it("returns every user-layer entry in one strict parse without rewriting JSONC", async () => {
		const fixture = await configFixture();
		const authored = `{
	// Comments and trailing commas are intentional raw JSONC.
	"version": 1,
	"providers": {
		"custom": {
			"mixed snowflake": {
				"type": "snowflake",
				"baseUrl": "https://private.example/cortex",
				"snowflake": { "account": "account-id" },
			},
			"unrelated": { "type": "ollama", "endpoint": "http://localhost:11434" },
		},
	},
}
`;
		await fixture.writeRawJsonc(authored);

		const entries = await readUserCustomProviderEntries({ configPath: fixture.configPath });
		expect(entries.size).toBe(2);
		expect(entries.get("mixed snowflake")).toEqual({
			type: "snowflake",
			baseUrl: "https://private.example/cortex",
			snowflake: { account: "account-id" },
		});
		expect(entries.get("unrelated")).toEqual({
			type: "ollama",
			endpoint: "http://localhost:11434",
		});
		expect(await fixture.readRaw()).toBe(authored);
		expect(await fixture.readBytes()).toEqual(Buffer.from(authored, "utf8"));
	});

	it("returns an empty map when providers.json is missing", async () => {
		const fixture = await configFixture();

		await expect(
			readUserCustomProviderEntries({ configPath: fixture.configPath }),
		).resolves.toEqual(new Map());
	});

	it("returns an empty map for an empty custom map", async () => {
		const fixture = await configFixture();
		await fixture.writeTypedConfig({ version: 1, providers: { custom: {} } });

		await expect(
			readUserCustomProviderEntries({ configPath: fixture.configPath }),
		).resolves.toEqual(new Map());
	});

	it("keeps prototype-named keys safe for membership checks", async () => {
		const fixture = await configFixture();
		await fixture.writeTypedConfig({
			version: 1,
			providers: { custom: { unrelated: { type: "ollama" } } },
		});

		const entries = await readUserCustomProviderEntries({ configPath: fixture.configPath });
		expect(entries.has("constructor")).toBe(false);
		expect(entries.has("unrelated")).toBe(true);
	});

	it.each([
		[
			"schema-invalid JSONC",
			'{ "version": 1, "providers": { "custom": { "gateway": { "type": "aws", "unexpected": true } } } }',
		],
		["malformed JSONC", '{ "version": 1, "providers": {'],
	] as const)("rejects %s instead of salvaging it", async (_case, raw) => {
		const fixture = await configFixture();
		await fixture.writeRawJsonc(raw);

		await expect(readUserCustomProviderEntries({ configPath: fixture.configPath })).rejects.toThrow(
			/Fix the file before editing custom providers/,
		);
	});

	it("rejects a directory at configPath as unreadable", async () => {
		const fixture = await configFixture();
		await mkdir(fixture.configPath);

		await expect(readUserCustomProviderEntries({ configPath: fixture.configPath })).rejects.toThrow(
			/Cannot read/,
		);
	});
});
