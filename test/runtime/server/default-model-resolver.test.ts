import { describe, expect, it } from "vitest";

import { parseCodexConfigModel } from "../../../src/server/default-model-resolver";

describe("parseCodexConfigModel", () => {
	it("reads the top-level model", () => {
		expect(parseCodexConfigModel('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n')).toBe("gpt-6.1-sol");
	});

	it("ignores model keys inside tables", () => {
		expect(parseCodexConfigModel('[profiles.x]\nmodel = "other"\n')).toBeNull();
	});
});
