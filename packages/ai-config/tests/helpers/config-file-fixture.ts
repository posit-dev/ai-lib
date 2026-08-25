/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProvidersConfig } from "../../src/types.js";

export interface ConfigFileFixture {
	/** Unique temporary directory. The directory exists, but providers.json does not. */
	readonly directory: string;
	/** Path to providers.json within {@link directory}. */
	readonly configPath: string;
	/** Write the supplied JSONC text exactly, without parsing or reformatting it. */
	writeRawJsonc(raw: string): Promise<void>;
	/** Atomically replace the file with the supplied JSONC text. */
	writeRawJsoncAtomic(raw: string): Promise<void>;
	/** Serialize and write a typed providers configuration as formatted JSON. */
	writeTypedConfig(config: ProvidersConfig): Promise<void>;
	/** Serialize and atomically replace the file with a typed providers configuration. */
	writeTypedConfigAtomic(config: ProvidersConfig): Promise<void>;
	/** Read providers.json as unmodified UTF-8 text. */
	readRaw(): Promise<string>;
	/** Read the exact bytes stored in providers.json. */
	readBytes(): Promise<Buffer>;
	/** Remove the fixture directory and all of its contents. Safe to call repeatedly. */
	cleanup(): Promise<void>;
}

/** Mirror the production writer's temp-file + rename replacement. */
async function writeAtomic(configPath: string, raw: string): Promise<void> {
	const tempPath = `${configPath}.tmp.${process.pid}`;
	try {
		await writeFile(tempPath, raw, { encoding: "utf8", mode: 0o644 });
		await rename(tempPath, configPath);
	} finally {
		await unlink(tempPath).catch(() => {});
	}
}

/** Create an isolated providers.json fixture without creating the config file itself. */
export async function createConfigFileFixture(): Promise<ConfigFileFixture> {
	const directory = await mkdtemp(join(tmpdir(), "ai-config-test-"));
	const configPath = join(directory, "providers.json");

	return {
		directory,
		configPath,
		writeRawJsonc: (raw) => writeFile(configPath, raw, "utf8"),
		writeRawJsoncAtomic: (raw) => writeAtomic(configPath, raw),
		writeTypedConfig: (config) =>
			writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
		writeTypedConfigAtomic: (config) =>
			writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`),
		readRaw: () => readFile(configPath, "utf8"),
		readBytes: () => readFile(configPath),
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}
