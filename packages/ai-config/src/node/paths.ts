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

/** Directory containing cross-product genai configuration. */
export const GENAI_CONFIG_DIR = path.join(os.homedir(), ".posit", "genai");

/** Full path to the providers.json config file. */
export const PROVIDERS_CONFIG_PATH = path.join(GENAI_CONFIG_DIR, "providers.json");

/**
 * Environment variable whose value is a JSON fragment of enforced config.
 * When set, the fragment is deep-merged over the user's file with enforced
 * keys winning (arrays replace, objects per-key merge).
 */
export const ENFORCED_ENV_VAR = "POSIT_GENAI_PROVIDERS_ENFORCED";

/**
 * Lockfile path used for cross-process safe writes to providers.json.
 * Hidden file next to the config file.
 */
export const PROVIDERS_LOCKFILE_PATH = `${PROVIDERS_CONFIG_PATH}.lock`;
