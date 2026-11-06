import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeWorkspaceStateResponse } from "../../../src/core/api-contract";
import { loadProjectStats } from "../../../src/server/project-stats";
import type { UsageLedgerRow } from "../../../src/server/usage-recorder";

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<UsageLedgerRow>): UsageLedgerRow {
	return {
		ts: NOW,
		taskId: "t1",
		agentId: "codex-chat",
		modelId: "gpt-5",
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 400,
		cacheWriteTokens: 10,
		costUsd: null,
		turns: 1,
		steps: 2,
		...overrides,
	};
}

function workspaceState(board: RuntimeBoardData): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/repo",
		statePath: "/state",
		git: { currentBranch: "main", defaultBranch: null, branches: [] },
		board,
		sessions: {},
		revision: 1,
	};
}

function boardWith(
	columns: Array<{
		id: RuntimeBoardData["columns"][number]["id"];
		cards: Array<{ id: string; createdAt: number; updatedAt: number }>;
	}>,
): RuntimeBoardData {
	return {
		columns: (["backlog", "in_progress", "review", "trash"] as const).map((id) => ({
			id,
			title: id,
			cards:
				columns
					.find((column) => column.id === id)
					?.cards.map((card) => ({
						id: card.id,
						title: card.id,
						prompt: card.id,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: card.createdAt,
						updatedAt: card.updatedAt,
					})) ?? [],
		})),
		dependencies: [],
	};
}

describe("loadProjectStats", () => {
	it("aggregates usage totals, cache hit rate, and daily buckets", async () => {
		const rows = [
			row({ ts: NOW }),
			row({
				ts: NOW - DAY,
				taskId: "t2",
				agentId: "claude-chat",
				modelId: "sonnet",
				cacheReadTokens: 0,
				costUsd: 0.2,
			}),
			row({ ts: NOW - 40 * DAY }),
		];
		const stats = await loadProjectStats("ws", 30, {
			now: () => NOW,
			readRows: async () => rows,
			loadWorkspaceState: async () => workspaceState(boardWith([])),
		});
		expect(stats.ok).toBe(true);
		// The 40-day-old row falls out of the 30-day window.
		expect(stats.usage.totals.taskCount).toBe(2);
		expect(stats.usage.totals.inputTokens).toBe(200);
		expect(stats.usage.totals.cacheReadTokens).toBe(400);
		expect(stats.usage.totals.costUsd).toBeCloseTo(0.2);
		expect(stats.usage.cacheHitPercent).toBe(64.5);
		expect(stats.usage.daily).toHaveLength(30);
		expect(stats.usage.byAgent.map((group) => group.key).sort()).toEqual(["claude-chat", "codex-chat"]);
		expect(stats.usage.byModel).toHaveLength(2);
	});

	it("derives flow metrics from the current board", async () => {
		const board = boardWith([
			{ id: "backlog", cards: [{ id: "b1", createdAt: NOW - DAY, updatedAt: NOW }] },
			{ id: "in_progress", cards: [{ id: "p1", createdAt: NOW - 2 * DAY, updatedAt: NOW }] },
			{
				id: "trash",
				cards: [{ id: "d1", createdAt: NOW - 2 * DAY - 4 * 60 * 60 * 1000, updatedAt: NOW - 4 * 60 * 60 * 1000 }],
			},
		]);
		const stats = await loadProjectStats("ws", 7, {
			now: () => NOW,
			readRows: async () => [],
			loadWorkspaceState: async () => workspaceState(board),
		});
		expect(stats.flow.totals.created).toBe(3);
		expect(stats.flow.totals.completed).toBe(1);
		expect(stats.flow.totals.wip).toBe(1);
		expect(stats.flow.totals.backlog).toBe(1);
		expect(stats.flow.totals.medianCycleMs).toBe(2 * DAY);
		expect(stats.usage.totals.totalTokens).toBe(0);
		expect(stats.usage.cacheHitPercent).toBeNull();
	});

	it("includes every daily bucket for the all-time range", async () => {
		const rows = [row({ ts: NOW }), row({ ts: NOW - 10 * DAY })];
		const stats = await loadProjectStats("ws", 0, {
			now: () => NOW,
			readRows: async () => rows,
			loadWorkspaceState: async () => workspaceState(boardWith([])),
		});
		expect(stats.usage.daily).toHaveLength(11);
		expect(stats.usage.totals.taskCount).toBe(1);
	});
});
