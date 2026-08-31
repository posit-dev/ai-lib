/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { migrateProvidersSchemaReference } from "../node/mutate-config.js";
import { parseJsonc } from "../node/parse-jsonc.js";
import { LEGACY_PROVIDERS_SCHEMA_PATH, PROVIDERS_SCHEMA_URL } from "../node/paths.js";

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
};

describe("migrateProvidersSchemaReference", () => {
	let fixture: ConfigFileFixture;
	let configPath: string;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
		configPath = fixture.configPath;
		vi.clearAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fixture.cleanup();
	});

	it("rewrites the legacy $schema literal, preserving comments and unknown fields", async () => {
		await fixture.writeRawJsonc(`{
	// Keep this comment.
	"$schema": "./providers.schema.json",
	"version": 1,
	"futureField": { "nested": true }
}
`);

		await migrateProvidersSchemaReference({ configPath, logger: mockLogger });

		const written = await fixture.readRaw();
		expect(written).toContain("Keep this comment");
		expect(parseJsonc(written)).toEqual({
			$schema: PROVIDERS_SCHEMA_URL,
			version: 1,
			futureField: { nested: true },
		});
	});

	it("leaves any other $schema (hosted, custom, absent) byte-identical", async () => {
		const cases = [
			`{\n  "$schema": "${PROVIDERS_SCHEMA_URL}",\n  "version": 1\n}\n`,
			'{\n  "$schema": "https://my-corp.example.com/providers.schema.json",\n  "version": 1\n}\n',
			'{\n  "version": 1\n}\n',
		];
		for (const original of cases) {
			await fixture.writeRawJsonc(original);

			await migrateProvidersSchemaReference({ configPath, logger: mockLogger });

			expect(await fixture.readRaw()).toBe(original);
		}
	});

	it("leaves a missing file missing and logs nothing", async () => {
		await migrateProvidersSchemaReference({ configPath, logger: mockLogger });

		await expect(fs.access(configPath)).rejects.toThrow();
		// Load-bearing: routing missing files through the catch-all would warn
		// on every fresh-install startup.
		expect(mockLogger.debug).not.toHaveBeenCalled();
		expect(mockLogger.warn).not.toHaveBeenCalled();
	});

	it("resolves without rejecting when the write fails, keeping the original bytes", async () => {
		await fixture.writeRawJsonc(`{ "$schema": "${LEGACY_PROVIDERS_SCHEMA_PATH}" }\n`);
		const originalBytes = await fixture.readBytes();
		const writeError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		vi.spyOn(fs, "writeFile").mockRejectedValueOnce(writeError);

		await expect(
			migrateProvidersSchemaReference({ configPath, logger: mockLogger }),
		).resolves.toBeUndefined();

		expect(mockLogger.warn).toHaveBeenCalledOnce();
		expect(await fixture.readBytes()).toEqual(originalBytes);
	});
});
