import { describe, expect, it } from "vitest";
import { createDefaultSummary } from "../../../src/cline-sdk/cline-session-state";
import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUsage } from "../../../src/core/api-contract";
import { createUsageRecorder, type UsageLedgerRow } from "../../../src/server/usage-recorder";

function summaryWithUsage(
	taskId: string,
	usage: Partial<RuntimeTaskSessionUsage>,
	startedAt: number | null = 1_000,
): RuntimeTaskSessionSummary {
	const base = createDefaultSummary(taskId);
	return {
		...base,
		state: "running",
		agentId: "codex-chat",
		modelId: "gpt-5",
		startedAt,
		usage: {
			...(base.usage ?? {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: null,
				turns: 0,
				steps: 0,
				contextTokens: null,
				contextWindowTokens: null,
				outputTokensPerSecond: null,
				updatedAt: 0,
			}),
			...usage,
		},
	};
}

function createRecorder() {
	const rows: UsageLedgerRow[] = [];
	const recorder = createUsageRecorder("ws-1", async (_path, row) => {
		rows.push(row);
	});
	return { rows, recorder };
}

describe("createUsageRecorder", () => {
	it("writes only increments between observations", async () => {
		const { rows, recorder } = createRecorder();
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 100, outputTokens: 10, turns: 1 }));
		await recorder.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ taskId: "t1", inputTokens: 100, outputTokens: 10, turns: 1 });

		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 160, outputTokens: 14, turns: 2, steps: 3 }));
		await recorder.flush();
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ inputTokens: 60, outputTokens: 4, turns: 1, steps: 3 });

		// Identical cumulative values produce no row.
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 160, outputTokens: 14, turns: 2, steps: 3 }));
		await recorder.flush();
		expect(rows).toHaveLength(2);
	});

	it("seeds baselines without writing history that predates tracking", async () => {
		const { rows, recorder } = createRecorder();
		recorder.seedSummary(summaryWithUsage("t1", { inputTokens: 5000, outputTokens: 700, turns: 9 }));
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 5100, outputTokens: 720, turns: 10 }));
		await recorder.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, turns: 1 });
	});

	it("counts a new run in full when startedAt changes", async () => {
		const { rows, recorder } = createRecorder();
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 4000, outputTokens: 500 }, 1_000));
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 200, outputTokens: 20 }, 2_000));
		await recorder.flush();
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({ inputTokens: 200, outputTokens: 20 });
	});

	it("reseats silently when totals drop within the same run", async () => {
		const { rows, recorder } = createRecorder();
		recorder.seedSummary(summaryWithUsage("t1", { inputTokens: 4000, outputTokens: 500 }));
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 100, outputTokens: 5 }));
		await recorder.flush();
		expect(rows).toHaveLength(0);
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 150, outputTokens: 8 }));
		await recorder.flush();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ inputTokens: 50, outputTokens: 3 });
	});

	it("ignores summaries without usage", async () => {
		const { rows, recorder } = createRecorder();
		recorder.recordSummary(createDefaultSummary("t1"));
		await recorder.flush();
		expect(rows).toHaveLength(0);
	});

	it("captures cost deltas", async () => {
		const { rows, recorder } = createRecorder();
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 10, costUsd: 0.01 }));
		recorder.recordSummary(summaryWithUsage("t1", { inputTokens: 10, costUsd: 0.025 }));
		await recorder.flush();
		expect(rows[0]?.costUsd).toBe(0.01);
		expect(rows[1]?.costUsd).toBeCloseTo(0.015);
	});
});
