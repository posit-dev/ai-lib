/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Default credential store path convention.
 *
 * The canonical location for Posit AI credential storage is
 * `~/.posit/ai/auth/data.json`, paralleling how `ai-config/node` owns
 * `~/.posit/ai/providers.json`.
 *
 * Consumers that want the standard path can call `getDefaultStorePath()` or
 * `createDefaultStore()` instead of constructing a `SingleFileStore` with a
 * hand-rolled path. The generic `SingleFileStore` constructor is unchanged
 * for non-default use cases (tests, custom paths).
 */

import * as os from "os";
import * as path from "path";

import { SingleFileStore } from "./SingleFileStore";
import type { LoggerLike } from "./types";

/**
 * Return the canonical default credential store file path:
 * `~/.posit/ai/auth/data.json`.
 */
export function getDefaultStorePath(): string {
	return path.join(os.homedir(), ".posit", "ai", "auth", "data.json");
}

/**
 * Create a `SingleFileStore` at the canonical default path
 * (`~/.posit/ai/auth/data.json`).
 *
 * This is a convenience factory for consumers that want the cross-product
 * default without independently knowing the path convention.
 *
 * @param logger - Optional logger compatible with `LoggerLike`.
 */
export function createDefaultStore(logger?: LoggerLike): SingleFileStore {
	return new SingleFileStore({ filePath: getDefaultStorePath() }, logger);
}
