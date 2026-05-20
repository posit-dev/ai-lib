/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step Logger Interface
 *
 * Interface for logging information about LLM API call steps.
 * Implementations can log to different destinations (JSON files, CSV, databases, etc.)
 */

import type { LanguageModelUsage } from "ai";

/**
 * Data passed to a step logger for each LLM API call step
 */
export interface StepLogData {
	/** Unique identifier for this streamText call */
	callId: string;
	/** Step index within this call (0, 1, 2, ...) */
	stepIndex: number;
	/** Provider name (e.g., "anthropic", "openai") */
	provider: string;
	/** Model identifier */
	model: string;
	/** Raw request body (may be null for streaming) */
	request: unknown;
	/** Response data (body, messages, finishReason) */
	response: unknown;
	/** Token usage information */
	usage: LanguageModelUsage;
	/** Provider-specific metadata */
	providerMetadata?: Record<string, unknown>;
	/** Response headers */
	headers: Record<string, string>;
}

/**
 * Interface for step loggers
 *
 * Implementations log information about LLM API call steps to various destinations.
 * Multiple loggers can be used simultaneously (e.g., JSON files + CSV).
 */
export interface StepLogger {
	/**
	 * Log a single step from an LLM API call
	 *
	 * @param data - Step data to log
	 */
	logStep(data: StepLogData): Promise<void>;

	/**
	 * Report that credits have been depleted (402 from gateway).
	 * Optional — only implemented by loggers that track license state.
	 */
	reportCreditsDepleted?(): void;

	/**
	 * Report that the user agreement has not been signed (403 from gateway).
	 * Optional — only implemented by loggers that track license state.
	 */
	reportAgreementRequired?(): void;
}
