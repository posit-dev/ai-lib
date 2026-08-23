/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { vi, type Mock } from "vitest";

export type RawFetchCall = Parameters<typeof fetch>;
export type RawFetchResponder = (...args: RawFetchCall) => ReturnType<typeof fetch>;

export interface RawFetchCapture {
	readonly mock: Mock<RawFetchResponder>;
	readonly calls: RawFetchCall[];
	call(index: number): RawFetchCall;
	single(): RawFetchCall;
}

/** Capture fetch arguments exactly as supplied while delegating every call to the responder. */
export function createRawFetchCapture(responder: RawFetchResponder): RawFetchCapture {
	const mock = vi.fn(responder);

	return {
		mock,
		get calls() {
			return mock.mock.calls;
		},
		call(index) {
			const call = mock.mock.calls[index];
			if (!call) {
				throw new Error(
					`Expected fetch call at index ${index}, but captured ${mock.mock.calls.length} call(s)`,
				);
			}
			return call;
		},
		single() {
			if (mock.mock.calls.length !== 1) {
				throw new Error(
					`Expected exactly one fetch call, but captured ${mock.mock.calls.length} call(s)`,
				);
			}
			return mock.mock.calls[0];
		},
	};
}
