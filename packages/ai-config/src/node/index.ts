/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config/node — Filesystem Entry
 *
 * Load, watch, and write ~/.posit/genai/providers.json with cross-process
 * locking, atomic writes, and typed change events. Imports the pure entry
 * for schema/validation; adds Node-specific I/O.
 *
 * Re-exports everything from the pure entry so consumers that need both
 * the types and the I/O can import from a single specifier.
 */

export * from "../index";
