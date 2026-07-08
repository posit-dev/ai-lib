/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal vscode module stub for testing the positron layer.
 *
 * Register in a test file with:
 *   vi.mock("vscode", () => import("./vscode-mock"));
 *
 * Only the runtime values (classes/enums) used by VscodeLmClient,
 * message-formats, and token-estimation are stubbed; pure types need no
 * runtime counterpart.
 */

export class LanguageModelTextPart {
	constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: object,
	) {}
}

export class LanguageModelDataPart {
	constructor(
		public data: Uint8Array,
		public mimeType: string,
	) {}

	static json(value: unknown, mime = "text/x-json"): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime);
	}

	static text(value: string, mime = "text/plain"): LanguageModelDataPart {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mime);
	}

	static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
		return new LanguageModelDataPart(data, mimeType);
	}
}

export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: unknown[],
	) {}
}

export class LanguageModelToolResultPart2 {
	constructor(
		public callId: string,
		public content: unknown[],
	) {}
}

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export class LanguageModelChatMessage2 {
	constructor(
		public role: LanguageModelChatMessageRole,
		public content: unknown[],
		public name?: string,
	) {}

	static User(content: string | unknown[], name?: string): LanguageModelChatMessage2 {
		const parts = typeof content === "string" ? [new LanguageModelTextPart(content)] : content;
		return new LanguageModelChatMessage2(LanguageModelChatMessageRole.User, parts, name);
	}

	static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage2 {
		const parts = typeof content === "string" ? [new LanguageModelTextPart(content)] : content;
		return new LanguageModelChatMessage2(LanguageModelChatMessageRole.Assistant, parts, name);
	}
}

export const LanguageModelChatMessage = LanguageModelChatMessage2;

export enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2,
}

export enum ChatImageMimeType {
	PNG = "image/png",
	JPEG = "image/jpeg",
	GIF = "image/gif",
	WEBP = "image/webp",
	BMP = "image/bmp",
}

export const lm = {
	selectChatModels: async () => [],
};
