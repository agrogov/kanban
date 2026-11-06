import { afterEach, describe, expect, it } from "vitest";

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

	it("rolls truncated breakdown groups into an Other row that reconciles with totals", async () => {
		// Ten agents with distinct token totals; only the top 8 are listed and the rest merge into "Other".
		const rows = Array.from({ length: 10 }, (_, index) =>
			row({
				taskId: `t${index}`,
				agentId: `agent-${index}`,
				inputTokens: (index + 1) * 100,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				turns: index + 1,
			}),
		);
		const stats = await loadProjectStats("ws", 7, {
			now: () => NOW,
			readRows: async () => rows,
			loadWorkspaceState: async () => workspaceState(boardWith([])),
		});
		expect(stats.usage.byAgent).toHaveLength(9);
		const other = stats.usage.byAgent[8];
		expect(other.key).toBe("other");
		expect(other.label).toBe("Other");
		// The two smallest groups (100 + 200 tokens) fall out of the top-8 cut.
		expect(other.totalTokens).toBe(300);
		expect(other.turns).toBe(3);
		expect(other.taskCount).toBe(2);
		// Breakdown sums reconcile with the section totals.
		expect(stats.usage.byAgent.reduce((sum, group) => sum + group.totalTokens, 0)).toBe(
			stats.usage.totals.totalTokens,
		);
		expect(stats.usage.byAgent.reduce((sum, group) => sum + group.turns, 0)).toBe(stats.usage.totals.turns);
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

	describe("DST day iteration", () => {
		// Regression for commit d993a9b7: fixed `cursor += MS_PER_DAY` stepping produced
		// duplicate dateKeys on 23h spring-forward days and skipped days on 25h fall-back days.
		const originalTz = process.env.TZ;
		afterEach(() => {
			if (originalTz === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = originalTz;
			}
		});

		function runWithNewYorkTz(body: () => Promise<void>): Promise<void> {
			process.env.TZ = "America/New_York";
			return body().finally(() => {
				if (originalTz === undefined) {
					delete process.env.TZ;
				} else {
					process.env.TZ = originalTz;
				}
			});
		}

		it("produces unique contiguous dateKeys across a 23-hour spring-forward day", async () => {
			await runWithNewYorkTz(async () => {
				// 2026-03-08 is the spring-forward day in America/New_York (23 hours long).
				// Fixed 24h stepping lands the cursor at 01:00 on 03-09, so with `now` at 00:30
				// the old code ended the series on 03-08 and dropped today entirely.
				const now = new Date(2026, 2, 9, 0, 30, 0).getTime();
				const stats = await loadProjectStats("ws", 7, {
					now: () => now,
					readRows: async () => [row({ ts: new Date(2026, 2, 8, 20, 0, 0).getTime() })],
					loadWorkspaceState: async () => workspaceState(boardWith([])),
				});
				const keys = stats.usage.daily.map((day) => day.date);
				expect(keys).toEqual([
					"2026-03-03",
					"2026-03-04",
					"2026-03-05",
					"2026-03-06",
					"2026-03-07",
					"2026-03-08",
					"2026-03-09",
				]);
				expect(new Set(keys).size).toBe(7);
				expect(stats.flow.daily.map((day) => day.date)).toEqual(keys);
				// The evening row on the short day must land on 03-08, not the duplicate bucket.
				expect(stats.usage.daily[5]?.inputTokens).toBe(100);
				expect(stats.usage.totals.inputTokens).toBe(100);
			});
		});

		it("produces unique contiguous dateKeys across a 25-hour fall-back day", async () => {
			await runWithNewYorkTz(async () => {
				// 2026-11-01 is the fall-back day in America/New_York (25 hours long).
				const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
				const stats = await loadProjectStats("ws", 7, {
					now: () => now,
					readRows: async () => [row({ ts: new Date(2026, 10, 1, 20, 0, 0).getTime() })],
					loadWorkspaceState: async () =>
						workspaceState(
							boardWith([
								{
									id: "trash",
									cards: [{ id: "d1", createdAt: new Date(2026, 9, 30, 9, 0, 0).getTime(), updatedAt: now }],
								},
							]),
						),
				});
				const keys = stats.usage.daily.map((day) => day.date);
				expect(keys).toEqual([
					"2026-10-27",
					"2026-10-28",
					"2026-10-29",
					"2026-10-30",
					"2026-10-31",
					"2026-11-01",
					"2026-11-02",
				]);
				expect(new Set(keys).size).toBe(7);
				// Flow buckets share the same day series and stay unique/contiguous.
				expect(stats.flow.daily.map((day) => day.date)).toEqual(keys);
				expect(stats.usage.daily[5]?.inputTokens).toBe(100);
				expect(stats.flow.daily[3]?.created).toBe(1);
				expect(stats.flow.totals.created).toBe(1);
			});
		});
	});
});
