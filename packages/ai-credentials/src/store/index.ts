/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credential-store — Generic Secret Store
 *
 * A typed key-value store backed by a single JSON file with atomic writes,
 * secure permissions (0o600), in-process mutex, cross-process locking, and
 * file watching.
 *
 * This package is a leaf dependency — it imports nothing from `@assistant/*`,
 * `ai-config`, `ai-provider-bridge`, or any SDK. Its only runtime deps are
 * `chokidar` (file watching) and `proper-lockfile` (cross-process locking).
 *
 * The store is type-parametric: callers provide their own value types via
 * `get<T>()` / `set<T>()`. Credential meaning (OAuth refresh, auth status,
 * provider grouping) stays with the consumer (e.g., `NodeAuthService`),
 * not here.
 */

export { SingleFileStore } from "./SingleFileStore";
export { createDefaultStore, getDefaultStorePath } from "./defaults";
export type { Disposable, LoggerLike, SingleFileStoreConfig } from "./types";
