/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SingleFileStore } from "../../src/store/index.js";

export interface SingleFileStoreFixture {
	readonly directory: string;
	readonly filePath: string;
	readonly store: SingleFileStore;
	writeBytes(bytes: Uint8Array): void;
	readBytes(): Buffer;
	cleanup(): void;
}

export function createSingleFileStoreFixture(
	prefix = "single-file-store-",
): SingleFileStoreFixture {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	const filePath = join(directory, "data.json");
	const store = new SingleFileStore({ filePath });

	return {
		directory,
		filePath,
		store,
		writeBytes(bytes) {
			writeFileSync(filePath, bytes);
		},
		readBytes() {
			return readFileSync(filePath);
		},
		cleanup() {
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
