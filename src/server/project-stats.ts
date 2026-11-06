// Server-side aggregation for the per-project Statistics view.
// Token/cost history comes from the workspace usage ledger (usage.jsonl), which only has
// data from the moment the feature shipped; board-flow stats are derived from the current
// board so they already cover pre-existing tasks.
import { readFile } from "node:fs/promises";
import type { RuntimeWorkspaceStateResponse } from "../core/api-contract";
import {
	type RuntimeProjectStatsFlowDay,
	type RuntimeProjectStatsRangeDays,
	type RuntimeProjectStatsResponse,
	type RuntimeProjectStatsUsageDay,
	type RuntimeProjectStatsUsageGroup,
	runtimeProjectStatsResponseSchema,
} from "../core/api-contract";
import { isLiveTaskSessionSummary } from "../core/task-session-state";
import { getWorkspaceUsagePath, loadWorkspaceStateById } from "../state/workspace-state";
import type { UsageLedgerRow } from "./usage-recorder";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Accumulator {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	hasCost: boolean;
	turns: number;
}

function createAccumulator(): Accumulator {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		hasCost: false,
		turns: 0,
	};
}

function addRow(accumulator: Accumulator, row: UsageLedgerRow): void {
	accumulator.inputTokens += Math.max(0, row.inputTokens);
	accumulator.outputTokens += Math.max(0, row.outputTokens);
	accumulator.cacheReadTokens += Math.max(0, row.cacheReadTokens);
	accumulator.cacheWriteTokens += Math.max(0, row.cacheWriteTokens);
	accumulator.turns += Math.max(0, row.turns);
	if (typeof row.costUsd === "number" && row.costUsd > 0) {
		accumulator.costUsd += row.costUsd;
		accumulator.hasCost = true;
	}
}

export function dateKey(ts: number): string {
	const date = new Date(ts);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function startOfDay(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

function totalTokens(acc: Accumulator): number {
	return acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
}

function parseLedgerRows(raw: string): UsageLedgerRow[] {
	const rows: UsageLedgerRow[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<UsageLedgerRow>;
			if (
				typeof parsed.ts === "number" &&
				typeof parsed.taskId === "string" &&
				typeof parsed.inputTokens === "number" &&
				typeof parsed.outputTokens === "number"
			) {
				rows.push({
					ts: parsed.ts,
					taskId: parsed.taskId,
					agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
					modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
					cacheWriteTokens: typeof parsed.cacheWriteTokens === "number" ? parsed.cacheWriteTokens : 0,
					costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : null,
					turns: typeof parsed.turns === "number" ? parsed.turns : 0,
					steps: typeof parsed.steps === "number" ? parsed.steps : 0,
				});
			}
		} catch {
			// Skip corrupt lines: a partially written append must not blank the whole report.
		}
	}
	return rows;
}

async function readUsageRows(workspaceId: string): Promise<UsageLedgerRow[]> {
	try {
		const raw = await readFile(getWorkspaceUsagePath(workspaceId), "utf8");
		return parseLedgerRows(raw);
	} catch {
		return [];
	}
}

function percentile(sortedValues: number[], fraction: number): number | null {
	if (sortedValues.length === 0) {
		return null;
	}
	const index = Math.min(sortedValues.length - 1, Math.floor(fraction * (sortedValues.length - 1)));
	return sortedValues[index];
}

function buildGroup(key: string, acc: Accumulator, taskIds: Set<string>): RuntimeProjectStatsUsageGroup {
	return {
		key,
		label: key,
		totalTokens: totalTokens(acc),
		inputTokens: acc.inputTokens,
		outputTokens: acc.outputTokens,
		costUsd: acc.hasCost ? acc.costUsd : null,
		turns: acc.turns,
		taskCount: taskIds.size,
	};
}

function topGroups(
	groups: Map<string, { acc: Accumulator; taskIds: Set<string> }>,
	limit: number,
): RuntimeProjectStatsUsageGroup[] {
	return Array.from(groups.entries())
		.map(([key, entry]) => buildGroup(key, entry.acc, entry.taskIds))
		.sort((left, right) => right.totalTokens - left.totalTokens)
		.slice(0, limit);
}

function daySeriesRange(rangeDays: RuntimeProjectStatsRangeDays, rows: UsageLedgerRow[], now: number): string[] {
	const keys: string[] = [];
	if (rangeDays > 0) {
		const start = startOfDay(now - (rangeDays - 1) * MS_PER_DAY);
		for (let cursor = start; cursor <= now; cursor += MS_PER_DAY) {
			keys.push(dateKey(cursor));
		}
		return keys;
	}
	const dataTs: number[] = rows.map((row) => row.ts);
	const oldest = dataTs.length > 0 ? Math.min(...dataTs) : now;
	const start = startOfDay(Math.min(oldest, now));
	// "All time" is capped so a years-old ledger cannot explode the payload; the cap only
	// trims the left edge, recent history is always included.
	const limitedStart = Math.max(start, startOfDay(now - 365 * MS_PER_DAY));
	for (let cursor = limitedStart; cursor <= now; cursor += MS_PER_DAY) {
		keys.push(dateKey(cursor));
	}
	return keys;
}

export interface LoadProjectStatsDependencies {
	readRows: (workspaceId: string) => Promise<UsageLedgerRow[]>;
	loadWorkspaceState: (workspaceId: string) => Promise<RuntimeWorkspaceStateResponse | null>;
	now: () => number;
}

const defaultDependencies: LoadProjectStatsDependencies = {
	readRows: readUsageRows,
	loadWorkspaceState: loadWorkspaceStateById,
	now: () => Date.now(),
};

export async function loadProjectStats(
	workspaceId: string,
	rangeDays: RuntimeProjectStatsRangeDays,
	overrides: Partial<LoadProjectStatsDependencies> = {},
): Promise<RuntimeProjectStatsResponse> {
	const deps = { ...defaultDependencies, ...overrides };
	const now = deps.now();
	const from = rangeDays > 0 ? startOfDay(now - (rangeDays - 1) * MS_PER_DAY) : 0;
	const [rows, workspaceState] = await Promise.all([deps.readRows(workspaceId), deps.loadWorkspaceState(workspaceId)]);
	const windowedRows = rows.filter((row) => row.ts >= from);

	const dayKeys = daySeriesRange(rangeDays, windowedRows, now);
	const usageByDay = new Map<string, Accumulator>();
	for (const key of dayKeys) {
		usageByDay.set(key, createAccumulator());
	}
	const totals = createAccumulator();
	const steps = { value: 0 };
	const taskIds = new Set<string>();
	const agentGroups = new Map<string, { acc: Accumulator; taskIds: Set<string> }>();
	const modelGroups = new Map<string, { acc: Accumulator; taskIds: Set<string> }>();
	for (const row of windowedRows) {
		addRow(totals, row);
		steps.value += Math.max(0, row.steps);
		taskIds.add(row.taskId);
		const day = usageByDay.get(dateKey(row.ts));
		if (day) {
			addRow(day, row);
		}
		const agentKey = row.agentId ?? "unknown";
		const agentEntry = agentGroups.get(agentKey) ?? { acc: createAccumulator(), taskIds: new Set<string>() };
		addRow(agentEntry.acc, row);
		agentEntry.taskIds.add(row.taskId);
		agentGroups.set(agentKey, agentEntry);
		const modelKey = row.modelId ?? "unknown";
		const modelEntry = modelGroups.get(modelKey) ?? { acc: createAccumulator(), taskIds: new Set<string>() };
		addRow(modelEntry.acc, row);
		modelEntry.taskIds.add(row.taskId);
		modelGroups.set(modelKey, modelEntry);
	}
	const usageDaily: RuntimeProjectStatsUsageDay[] = dayKeys.map((date) => {
		const acc = usageByDay.get(date) ?? createAccumulator();
		return {
			date,
			inputTokens: acc.inputTokens,
			outputTokens: acc.outputTokens,
			cacheReadTokens: acc.cacheReadTokens,
			cacheWriteTokens: acc.cacheWriteTokens,
			totalTokens: totalTokens(acc),
			costUsd: acc.hasCost ? acc.costUsd : null,
			turns: acc.turns,
		};
	});
	const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

	// Board flow: derived from the current board, so it covers tasks created before this
	// feature shipped. Completed = cards in Done, keyed by their last update.
	const columns = workspaceState?.board.columns ?? [];
	const columnByCard = new Map<string, string>();
	for (const column of columns) {
		for (const card of column.cards) {
			columnByCard.set(card.id, column.id);
		}
	}
	const allCards = columns.flatMap((column) => column.cards);
	const createdInRange = allCards.filter((card) => card.createdAt >= from);
	const doneCards = allCards.filter((card) => columnByCard.get(card.id) === "trash");
	const completedCards = doneCards.filter((card) => card.updatedAt >= from);
	const cycleTimes = doneCards
		.filter((card) => card.updatedAt >= from)
		.map((card) => Math.max(0, card.updatedAt - card.createdAt))
		.sort((left, right) => left - right);
	const flowDayKeys = dayKeys.length > 0 ? dayKeys : [dateKey(now)];
	const flowByDay = new Map<string, { created: number; completed: number }>();
	for (const key of flowDayKeys) {
		flowByDay.set(key, { created: 0, completed: 0 });
	}
	for (const card of createdInRange) {
		const bucket = flowByDay.get(dateKey(card.createdAt));
		if (bucket) {
			bucket.created += 1;
		}
	}
	for (const card of completedCards) {
		const bucket = flowByDay.get(dateKey(card.updatedAt));
		if (bucket) {
			bucket.completed += 1;
		}
	}
	const flowDaily: RuntimeProjectStatsFlowDay[] = flowDayKeys.map((date) => ({
		date,
		created: flowByDay.get(date)?.created ?? 0,
		completed: flowByDay.get(date)?.completed ?? 0,
	}));
	const liveSessions = workspaceState
		? Object.values(workspaceState.sessions).filter((summary) => isLiveTaskSessionSummary(summary))
		: [];
	const countInColumn = (columnId: string) => allCards.filter((card) => columnByCard.get(card.id) === columnId).length;

	return runtimeProjectStatsResponseSchema.parse({
		ok: true,
		rangeDays,
		from: rangeDays > 0 ? from : dayKeys.length > 0 ? new Date(`${dayKeys[0]}T00:00:00`).getTime() : now,
		to: now,
		usage: {
			totals: {
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheReadTokens: totals.cacheReadTokens,
				cacheWriteTokens: totals.cacheWriteTokens,
				totalTokens: totalTokens(totals),
				costUsd: totals.hasCost ? totals.costUsd : null,
				turns: totals.turns,
				steps: steps.value,
				taskCount: taskIds.size,
			},
			cacheHitPercent: promptTokens > 0 ? Math.round((totals.cacheReadTokens / promptTokens) * 1000) / 10 : null,
			daily: usageDaily,
			byAgent: topGroups(agentGroups, 8),
			byModel: topGroups(modelGroups, 8),
		},
		flow: {
			totals: {
				created: createdInRange.length,
				completed: completedCards.length,
				wip: countInColumn("in_progress") + countInColumn("review"),
				backlog: countInColumn("backlog"),
				activeTasks: liveSessions.length,
				medianCycleMs: percentile(cycleTimes, 0.5),
				p90CycleMs: percentile(cycleTimes, 0.9),
			},
			daily: flowDaily,
		},
	});
}
