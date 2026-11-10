import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadAutoReviewCheckConfig,
	loadAutoReviewDoneCheckConfig,
	parseAutoReviewCheckConfig,
	parseAutoReviewDoneCheckConfig,
} from "../../../src/config/auto-review-check-config";
import { createTempDir } from "../../utilities/temp-dir";

async function loadWith<T>(
	contents: string | null,
	load: (path: string) => Promise<T> = loadAutoReviewCheckConfig as (path: string) => Promise<T>,
): Promise<T> {
	const { path, cleanup } = createTempDir("kanban-auto-review-check-");
	try {
		if (contents !== null) {
			mkdirSync(join(path, ".cline", "kanban"), { recursive: true });
			writeFileSync(join(path, ".cline", "kanban", "config.json"), contents, "utf8");
		}
		return await load(path);
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

describe("auto-review done check config", () => {
	const loadDone = (contents: string | null) => loadWith(contents, loadAutoReviewDoneCheckConfig);

	it("applies the default timeout", () => {
		expect(parseAutoReviewDoneCheckConfig({ command: " sh check.sh " })).toEqual({
			command: "sh check.sh",
			timeoutMs: 10 * 60_000,
		});
	});

	it("returns null without the key, even when the pre-commit check is set", async () => {
		await expect(loadDone(null)).resolves.toBeNull();
		await expect(loadDone(JSON.stringify({ autoReviewCheck: { command: "npm test" } }))).resolves.toBeNull();
	});

	it("reads the configured done check", async () => {
		await expect(
			loadDone(JSON.stringify({ autoReviewDoneCheck: { command: "sh check.sh", timeoutMinutes: 2 } })),
		).resolves.toEqual({ command: "sh check.sh", timeoutMs: 2 * 60_000 });
	});

	it("throws on a broken entry so landed cards are held", async () => {
		await expect(loadDone("{ not json")).rejects.toThrow();
		await expect(loadDone(JSON.stringify({ autoReviewDoneCheck: { command: "" } }))).rejects.toThrow();
		await expect(
			loadDone(JSON.stringify({ autoReviewDoneCheck: { command: "x", timeoutMinutes: 0 } })),
		).rejects.toThrow();
	});
});
