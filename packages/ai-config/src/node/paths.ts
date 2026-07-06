/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized path and env-var constants for providers.json.
 *
 * All filesystem paths and environment variable names are defined here so
 * a future rename is a one-line edit.
 */

import * as os from "os";
import * as path from "path";

/** Directory containing cross-product AI configuration. */
export const AI_CONFIG_DIR = path.join(os.homedir(), ".posit", "ai");

/** Full path to the providers.json config file. */
export const PROVIDERS_CONFIG_PATH = path.join(AI_CONFIG_DIR, "providers.json");

/**
 * Environment variable whose value is a JSON fragment of **enforced** config
 * — the sealed admin overlay. When set, the fragment deep-merges over every
 * lower-precedence source with enforced keys winning (arrays replace, objects
 * per-key merge) and can never be overridden.
 */
export const ENFORCED_ENV_VAR = "POSIT_AI_PROVIDERS_ENFORCED";

/**
 * Environment variable whose value is a JSON fragment of **default** config
 * — Workbench admin defaults. Sits below the user file and host settings, so
 * a user's `providers.json` (or host `authentication.*`) overrides it. Uses
 * the same relaxed fragment shape as the enforced overlay.
 */
export const DEFAULT_ENV_VAR = "POSIT_AI_PROVIDERS_DEFAULT";

/**
 * Lockfile path used for cross-process safe writes to providers.json.
 * Hidden file next to the config file.
 */
export const PROVIDERS_LOCKFILE_PATH = `${PROVIDERS_CONFIG_PATH}.lock`;
