/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getInferenceProfilePrefix } from "../bedrock-provider";

describe("getInferenceProfilePrefix", () => {
	it("uses the us-gov partition for AWS GovCloud regions", () => {
		// Regression: GovCloud regions also start with "us-", so they must be
		// matched before the general us- case or they'd get the commercial "us."
		// prefix, whose inference profiles don't exist in GovCloud.
		expect(getInferenceProfilePrefix("us-gov-west-1")).toBe("us-gov");
		expect(getInferenceProfilePrefix("us-gov-east-1")).toBe("us-gov");
	});

	it("maps commercial regions to their partition prefixes", () => {
		expect(getInferenceProfilePrefix("us-east-1")).toBe("us");
		expect(getInferenceProfilePrefix("us-west-2")).toBe("us");
		expect(getInferenceProfilePrefix("eu-west-1")).toBe("eu");
		expect(getInferenceProfilePrefix("eu-central-1")).toBe("eu");
		expect(getInferenceProfilePrefix("ap-northeast-1")).toBe("apac");
		expect(getInferenceProfilePrefix("ap-southeast-1")).toBe("apac");
	});

	it("defaults unknown regions to us", () => {
		expect(getInferenceProfilePrefix("ca-central-1")).toBe("us");
	});
});
