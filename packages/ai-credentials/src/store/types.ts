/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types for ai-credential-store.
 *
 * Defines local interfaces to avoid any dependency on `@assistant/core` or
 * other packages. The `LoggerLike` interface replaces the `Logger` import
 * that the original SingleFileStore had from `@assistant/core`.
 */

// ---------------------------------------------------------------------------
// Store configuration
// ---------------------------------------------------------------------------

export interface SingleFileStoreConfig {
	/** Absolute path to the JSON store file (e.g., ~/.posit/assistant/store/data.json). */
	filePath: string;
}

// ---------------------------------------------------------------------------
// Logger interface (local — no @assistant/core dependency)
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface. Matches the subset of `@assistant/core`'s Logger
 * that the store actually uses, so any compatible logger can be passed in.
 *
 * Optional: the store gracefully handles `undefined` logger.
 */
export interface LoggerLike {
	debug(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

/**
 * A resource that can be disposed/cleaned up.
 */
export interface Disposable {
	dispose(): void;
}
