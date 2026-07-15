/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

interface DeepSeekModelCapabilities {
	displayName: string;
	family: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
	thinkingEffortLevels?: string[];
}

const THINKING_LEVELS = ["off", "high", "max"];

const CAPABILITY_RULES: [RegExp, DeepSeekModelCapabilities][] = [
	[
		/^deepseek-v4-pro/,
		{
			displayName: "DeepSeek V4 Pro",
			family: "deepseek-v4",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 384_000,
			supportsTools: true,
			supportsImages: false,
			thinkingEffortLevels: THINKING_LEVELS,
		},
	],
	[
		/^deepseek-v4-flash/,
		{
			displayName: "DeepSeek V4 Flash",
			family: "deepseek-v4",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 384_000,
			supportsTools: true,
			supportsImages: false,
			thinkingEffortLevels: THINKING_LEVELS,
		},
	],
	[
		/^deepseek-reasoner/,
		{
			displayName: "DeepSeek Reasoner",
			family: "deepseek-v4",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 384_000,
			supportsTools: true,
			supportsImages: false,
			thinkingEffortLevels: THINKING_LEVELS,
		},
	],
	[
		/^deepseek-chat/,
		{
			displayName: "DeepSeek Chat",
			family: "deepseek-v4",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 384_000,
			supportsTools: true,
			supportsImages: false,
			thinkingEffortLevels: THINKING_LEVELS,
		},
	],
];

const DEFAULT_CAPABILITIES: DeepSeekModelCapabilities = {
	displayName: "",
	family: "deepseek",
	maxInputTokens: 128_000,
	maxOutputTokens: 8_192,
	supportsTools: true,
	supportsImages: false,
	thinkingEffortLevels: THINKING_LEVELS,
};

export function getDeepSeekModelCapabilities(modelId: string): DeepSeekModelCapabilities {
	for (const [pattern, caps] of CAPABILITY_RULES) {
		if (pattern.test(modelId)) {
			return caps;
		}
	}
	return { ...DEFAULT_CAPABILITIES, displayName: modelId };
}
