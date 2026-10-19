/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { StepResultPerformance } from "ai";

/**
 * `performance` for `finish-step` parts synthesized outside `streamText`
 * (vscode.lm, Copilot SDK), which measure no timing. AI SDK 7 requires the
 * field, so these clients report zeros.
 */
export const UNMEASURED_STEP_PERFORMANCE: StepResultPerformance = {
	effectiveOutputTokensPerSecond: 0,
	outputTokensPerSecond: undefined,
	inputTokensPerSecond: undefined,
	effectiveTotalTokensPerSecond: 0,
	stepTimeMs: 0,
	responseTimeMs: 0,
	toolExecutionMs: {},
	timeToFirstOutputMs: undefined,
};
