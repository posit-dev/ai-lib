/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config — Pure Entry
 *
 * Platform-agnostic schema, types, validation, and resolution helpers for
 * ~/.posit/genai/providers.json. No filesystem imports — runs in any JS
 * environment (browser, Node, test).
 *
 * The ./node entry (ai-config/node) adds filesystem I/O: load, watch, write.
 */

/** On-disk config file version. */
export const PROVIDERS_CONFIG_VERSION = 1;
