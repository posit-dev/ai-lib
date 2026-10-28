/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The headless entry must satisfy the contract frozen below for `HEADLESS_CONTRACT_VERSION` 1.
 * For an intended break, bump the version and replace the frozen contract.
 * Functions are properties, not methods, so their parameters are checked strictly.
 */

import type * as Headless from "ai-provider-bridge/headless";

interface LoggerV1 {
	readonly info: (message: string, ...args: unknown[]) => void;
	readonly warn: (message: string, ...args: unknown[]) => void;
	readonly error: (message: string, ...args: unknown[]) => void;
	readonly debug: (message: string, ...args: unknown[]) => void;
	readonly trace: (message: string, ...args: unknown[]) => void;
}

interface DisposableV1 {
	readonly dispose: () => void;
}

interface CancellationTokenV1 {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: (listener: (e: unknown) => void) => DisposableV1;
}

interface HeadlessProvidersOptionsV1 {
	readonly logger: LoggerV1;
	readonly userAgent: string;
	readonly catalog: {
		readonly configPath?: string;
		readonly envVars: Record<string, string | undefined>;
	};
}

interface HeadlessProviderDataV1 {
	readonly id: string;
	readonly enabled: boolean;
	readonly custom?: true;
	readonly baseUrl?: string;
	readonly positaiLoginScope?: string;
	readonly customizedConnection?: readonly string[];
}

interface HeadlessCatalogChangeV1 {
	readonly catalog: readonly HeadlessProviderDataV1[];
	readonly enabledChanged: boolean;
	readonly connectionChanged: boolean;
	readonly modelsChanged: boolean;
}

interface HeadlessProviderMappingV1 {
	readonly providerId: string;
	readonly authProviderId?: string;
	readonly scopes: readonly string[];
	readonly requiresSession: boolean;
}

interface HeadlessModelV1 {
	readonly id: string;
	readonly name: string;
	readonly vendor: string;
	readonly providerId: string;
}

interface HeadlessModelListingV1 {
	readonly credentialed: boolean;
	readonly models: readonly HeadlessModelV1[];
}

interface HeadlessChatRequestV1 {
	readonly providerId: string;
	readonly modelId: string;
	readonly sessionToken?: string;
	readonly systemPrompt: string;
	readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
	readonly maxOutputTokens?: number;
}

interface HeadlessProvidersV1 {
	readonly configPath: string;
	readonly getCatalog: () => Promise<readonly HeadlessProviderDataV1[]>;
	readonly onDidChangeCatalog: (
		listener: (change: HeadlessCatalogChangeV1) => void,
	) => DisposableV1;
	readonly getProviderMappings: () => Promise<readonly HeadlessProviderMappingV1[]>;
	readonly listModels: (
		providerId: string,
		sessionToken: string | undefined,
	) => Promise<HeadlessModelListingV1>;
	readonly streamChat: (
		request: HeadlessChatRequestV1,
		token: CancellationTokenV1,
	) => AsyncIterable<string>;
	readonly dispose: () => void;
}

interface HeadlessContractV1 {
	readonly HEADLESS_CONTRACT_VERSION: 1;
	readonly CUSTOM_PROVIDERS_AUTH_PROVIDER_ID: string;
	readonly createHeadlessProviders: (options: HeadlessProvidersOptionsV1) => HeadlessProvidersV1;
}

const _headlessContractV1: typeof Headless extends HeadlessContractV1 ? true : never = true;
