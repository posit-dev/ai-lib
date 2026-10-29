/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

export { createHeadlessProviders } from "./headless/create-headless-providers.js";
export { CUSTOM_PROVIDERS_AUTH_PROVIDER_ID } from "./headless/mappings.js";
export type * from "./headless/types.js";

/**
 * Positron uses Posit Assistant's copy of this entry only when this number matches its own.
 * Bump it only for breaking changes to the entry's runtime exports.
 */
export const HEADLESS_CONTRACT_VERSION = 1;
