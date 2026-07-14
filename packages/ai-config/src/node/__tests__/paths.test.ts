/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { AI_CONFIG_DIR, PROVIDERS_CONFIG_PATH, PROVIDERS_LOCKFILE_PATH } from "../paths.js";

describe("ai-config path constants", () => {
	const home = os.homedir();

	it("AI_CONFIG_DIR resolves under ~/.posit/ai", () => {
		expect(AI_CONFIG_DIR).toBe(path.join(home, ".posit", "ai"));
	});

	it("PROVIDERS_CONFIG_PATH resolves under ~/.posit/ai/providers.json", () => {
		expect(PROVIDERS_CONFIG_PATH).toBe(path.join(home, ".posit", "ai", "providers.json"));
	});

	it("PROVIDERS_LOCKFILE_PATH is providers.json.lock", () => {
		expect(PROVIDERS_LOCKFILE_PATH).toBe(`${PROVIDERS_CONFIG_PATH}.lock`);
	});
});
