import { describe, expect, it } from "vitest";

import {
	applyTaskSessionUsageUpdate,
	createEmptyTaskSessionUsage,
	diffUsageTotals,
	sumTaskSessionUsageTokens,
	tokensPerSecond,
} from "../../../src/core/task-session-usage";

describe("applyTaskSessionUsageUpdate", () => {
	it("accumulates token deltas onto an empty baseline", () => {
		const first = applyTaskSessionUsageUpdate(null, { inputTokens: 100, outputTokens: 20 }, 1);
		const second = applyTaskSessionUsageUpdate(first, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 300 }, 2);
		expect(second).toMatchObject({
			inputTokens: 150,
			outputTokens: 25,
			cacheReadTokens: 300,
			cacheWriteTokens: 0,
		});
		expect(sumTaskSessionUsageTokens(second)).toBe(475);
	});

	it("ignores negative or non-finite deltas", () => {
		const base = createEmptyTaskSessionUsage(0);
		const next = applyTaskSessionUsageUpdate(base, { inputTokens: -10, outputTokens: Number.NaN, turns: -1 }, 1);
		expect(next.inputTokens).toBe(0);
		expect(next.outputTokens).toBe(0);
		expect(next.turns).toBe(0);
	});

	it("keeps cost null until a cost is reported, then accumulates", () => {
		const base = createEmptyTaskSessionUsage(0);
		expect(applyTaskSessionUsageUpdate(base, { outputTokens: 10 }, 1).costUsd).toBeNull();
		const withCost = applyTaskSessionUsageUpdate(base, { costUsd: 0.02 }, 1);
		expect(withCost.costUsd).toBe(0.02);
		expect(applyTaskSessionUsageUpdate(withCost, { costUsd: 0.03 }, 2).costUsd).toBeCloseTo(0.05);
	});

	it("replaces context fields only when the update provides them", () => {
		let usage = applyTaskSessionUsageUpdate(
			null,
			{ contextTokens: 1000, contextWindowTokens: 8000, outputTokensPerSecond: 12 },
			1,
		);
		expect(usage.contextTokens).toBe(1000);
		usage = applyTaskSessionUsageUpdate(usage, { contextTokens: 2500 }, 2);
		expect(usage.contextTokens).toBe(2500);
		expect(usage.contextWindowTokens).toBe(8000);
		expect(usage.outputTokensPerSecond).toBe(12);
	});
});

describe("diffUsageTotals", () => {
	it("produces per-event increments from cumulative totals", () => {
		const previous = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 10, costUsd: 0.5 };
		const current = { inputTokens: 180, outputTokens: 55, cacheReadTokens: 500, cacheWriteTokens: 20, costUsd: 0.8 };
		const update = diffUsageTotals(previous, current);
		expect(update).toMatchObject({ inputTokens: 80, outputTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 10 });
		expect(update.costUsd).toBeCloseTo(0.3);
	});

	it("treats the first report as the full increment and clamps regressions", () => {
		const first = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
		expect(diffUsageTotals(null, first)).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0 });
		const regressed = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
		const update = diffUsageTotals(first, regressed);
		expect(update.inputTokens).toBe(0);
		expect(update.outputTokens).toBe(0);
	});
});

describe("tokensPerSecond", () => {
	it("converts output tokens over wall time", () => {
		expect(tokensPerSecond(100, 2000)).toBe(50);
	});
	it("returns undefined for empty or broken windows", () => {
		expect(tokensPerSecond(0, 1000)).toBeUndefined();
		expect(tokensPerSecond(10, 0)).toBeUndefined();
	});
});
