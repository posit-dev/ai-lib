/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level variable for mocking homedir.
let mockHome: string | undefined;

vi.mock("os", async (importOriginal) => {
	const original = await importOriginal<typeof os>();
	return { ...original, homedir: () => mockHome ?? original.homedir() };
});

// Import AFTER mocks are registered.
const { createDefaultStore } = await import("../defaults.js");

describe("createDefaultStore", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "default-store-test-"));
		mockHome = tmpHome;
	});

	afterEach(async () => {
		mockHome = undefined;
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	it("creates a store that writes to the default path", async () => {
		const store = createDefaultStore();
		await store.set("test-key", { value: 42 });

		// Verify the file was written at the expected path
		const expectedPath = path.join(tmpHome, ".posit", "ai", "auth", "data.json");
		const raw = await fs.readFile(expectedPath, "utf-8");
		const data = JSON.parse(raw);
		expect(data["test-key"]).toEqual({ value: 42 });
	});
});
