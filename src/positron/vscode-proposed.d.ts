/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Positron-specific VS Code proposed API types needed by provider-bridge.
 *
 *  These types augment the standard vscode module with proposed Language Model
 *  API extensions available in Positron. Sourced from Positron's proposed API
 *  declarations.
 *--------------------------------------------------------------------------------------------*/

declare module "vscode" {
	export interface LanguageModelChat {
		sendRequest(
			messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
			options?: LanguageModelChatRequestOptions,
			token?: CancellationToken,
		): Thenable<LanguageModelChatResponse>;
		countTokens(
			text: string | LanguageModelChatMessage | LanguageModelChatMessage2,
			token?: CancellationToken,
		): Thenable<number>;
	}

	export class LanguageModelChatMessage2 {
		static User(
			content:
				| string
				| Array<LanguageModelTextPart | LanguageModelToolResultPart2 | LanguageModelDataPart>,
			name?: string,
		): LanguageModelChatMessage2;

		static Assistant(
			content:
				| string
				| Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelDataPart>,
			name?: string,
		): LanguageModelChatMessage2;

		role: LanguageModelChatMessageRole;

		content: Array<
			| LanguageModelTextPart
			| LanguageModelToolResultPart2
			| LanguageModelToolCallPart
			| LanguageModelDataPart
		>;

		name: string | undefined;

		constructor(
			role: LanguageModelChatMessageRole,
			content:
				| string
				| Array<
						| LanguageModelTextPart
						| LanguageModelToolResultPart2
						| LanguageModelToolCallPart
						| LanguageModelDataPart
				  >,
			name?: string,
		);
	}

	export class LanguageModelDataPart {
		static image(data: Uint8Array, mimeType: ChatImageMimeType): LanguageModelDataPart;
		static json(value: any, mime?: string): LanguageModelDataPart;
		static text(value: string, mime?: string): LanguageModelDataPart;

		mimeType: string;
		data: Uint8Array;

		constructor(data: Uint8Array, mimeType: string);
	}

	export enum ChatImageMimeType {
		PNG = "image/png",
		JPEG = "image/jpeg",
		GIF = "image/gif",
		WEBP = "image/webp",
		BMP = "image/bmp",
	}

	export class LanguageModelToolResultPart2 {
		callId: string;
		content: Array<
			LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
		>;
		constructor(
			callId: string,
			content: Array<
				LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
			>,
		);
	}

	export class LanguageModelToolResult2 {
		content: Array<
			LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
		>;
		constructor(
			content: Array<
				LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
			>,
		);
	}
}
