import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAutoReviewCheckConfig, parseAutoReviewCheckConfig } from "../../../src/config/auto-review-check-config";
import { createTempDir } from "../../utilities/temp-dir";

async function loadWith(contents: string | null) {
	const { path, cleanup } = createTempDir("kanban-auto-review-check-");
	try {
		if (contents !== null) {
			mkdirSync(join(path, ".cline", "kanban"), { recursive: true });
			writeFileSync(join(path, ".cline", "kanban", "config.json"), contents, "utf8");
		}
		return await loadAutoReviewCheckConfig(path);
	} finally {
		cleanup();
	}
}

describe("parseAutoReviewCheckConfig", () => {
	it("applies the defaults", () => {
		expect(parseAutoReviewCheckConfig({ command: " npm test " })).toEqual({
			command: "npm test",
			timeoutMs: 30 * 60_000,
			maxRetries: 1,
		});
	});

	it("allows retries to be disabled", () => {
		expect(parseAutoReviewCheckConfig({ command: "x", maxRetries: 0 }).maxRetries).toBe(0);
	});

	it("rejects an empty command and bad numbers", () => {
		expect(() => parseAutoReviewCheckConfig({ command: "  " })).toThrow();
		expect(() => parseAutoReviewCheckConfig({ command: "x", timeoutMinutes: 0 })).toThrow();
		expect(() => parseAutoReviewCheckConfig({ command: "x", maxRetries: -1 })).toThrow();
	});
});

describe("loadAutoReviewCheckConfig", () => {
	it("returns null without a config file or without the key", async () => {
		await expect(loadWith(null)).resolves.toBeNull();
		await expect(loadWith(JSON.stringify({ shortcuts: [] }))).resolves.toBeNull();
	});

	it("reads the configured check", async () => {
		await expect(loadWith(JSON.stringify({ autoReviewCheck: { command: "npm test" } }))).resolves.toMatchObject({
			command: "npm test",
		});
	});

	it("throws on a broken file so cards are held rather than merged unchecked", async () => {
		await expect(loadWith("{ not json")).rejects.toThrow();
		await expect(loadWith(JSON.stringify({ autoReviewCheck: {} }))).rejects.toThrow();
	});
});
