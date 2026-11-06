// Server-side aggregation for the per-project Statistics view.
// Token/cost history comes from the workspace usage ledger (usage.jsonl), which only has
// data from the moment the feature shipped; board-flow stats are derived from the current
// board so they already cover pre-existing tasks. Ledger parsing and size-bounded
// compaction live in usage-ledger.ts; compaction is a lossless fold, so aggregates here
// are identical before and after it.
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
import { dateKey, readUsageLedgerRows, type UsageLedgerRow } from "./usage-ledger";

// `dateKey` is owned by usage-ledger.ts (compaction groups by it); re-exported here for
// existing callers that key stats output by day.
export { dateKey };

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

function startOfDay(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

// Local midnight `daysAgo` *calendar* days before `now`. Stepping back by n * 24h instead
// lands on the wrong day across DST transitions (23h and 25h days), which duplicates or
// skips dateKeys in the daily series.
function startOfDayDaysAgo(now: number, daysAgo: number): number {
	const date = new Date(startOfDay(now));
	date.setDate(date.getDate() - daysAgo);
	return date.getTime();
}

function totalTokens(acc: Accumulator): number {
	return acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
}

async function readUsageRows(workspaceId: string): Promise<UsageLedgerRow[]> {
	// Oversized ledgers are compacted here (older per-session rows rolled into
	// per-day aggregates) before parsing, keeping read cost bounded.
	return await readUsageLedgerRows(getWorkspaceUsagePath(workspaceId));
}

function percentile(sortedValues: number[], fraction: number): number | null {
	if (sortedValues.length === 0) {
		return null;
	}
	const index = Math.min(sortedValues.length - 1, Math.floor(fraction * (sortedValues.length - 1)));
	return sortedValues[index];
}

function buildGroup(key: string, label: string, acc: Accumulator, taskIds: Set<string>): RuntimeProjectStatsUsageGroup {
	return {
		key,
		label,
		totalTokens: totalTokens(acc),
		inputTokens: acc.inputTokens,
		outputTokens: acc.outputTokens,
		costUsd: acc.hasCost ? acc.costUsd : null,
		turns: acc.turns,
		taskCount: taskIds.size,
	};
}

function addAccumulator(target: Accumulator, source: Accumulator): void {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.turns += source.turns;
	target.costUsd += source.costUsd;
	if (source.hasCost) {
		target.hasCost = true;
	}
}

const OTHER_GROUP_KEY = "other";
const OTHER_GROUP_LABEL = "Other";

function topGroups(
	groups: Map<string, { acc: Accumulator; taskIds: Set<string> }>,
	limit: number,
): RuntimeProjectStatsUsageGroup[] {
	const sorted = Array.from(groups.entries())
		.map(([key, entry]) => ({ key, acc: entry.acc, taskIds: entry.taskIds }))
		.sort((left, right) => totalTokens(right.acc) - totalTokens(left.acc));
	const top = sorted.slice(0, limit).map((entry) => buildGroup(entry.key, entry.key, entry.acc, entry.taskIds));
	const overflow = sorted.slice(limit);
	if (overflow.length === 0) {
		return top;
	}
	// Roll the truncated remainder into an "Other" row so breakdown sums reconcile with totals.
	const merged = createAccumulator();
	const mergedTaskIds = new Set<string>();
	for (const entry of overflow) {
		addAccumulator(merged, entry.acc);
		for (const taskId of entry.taskIds) {
			mergedTaskIds.add(taskId);
		}
	}
	top.push(buildGroup(OTHER_GROUP_KEY, OTHER_GROUP_LABEL, merged, mergedTaskIds));
	return top;
}

function daySeriesRange(rangeDays: RuntimeProjectStatsRangeDays, rows: UsageLedgerRow[], now: number): string[] {
	let start: number;
	if (rangeDays > 0) {
		start = startOfDayDaysAgo(now, rangeDays - 1);
	} else {
		const dataTs: number[] = rows.map((row) => row.ts);
		const oldest = dataTs.length > 0 ? Math.min(...dataTs) : now;
		// "All time" is capped so a years-old ledger cannot explode the payload; the cap only
		// trims the left edge, recent history is always included.
		start = Math.max(startOfDay(Math.min(oldest, now)), startOfDayDaysAgo(now, 365));
	}
	// Advance one calendar day at a time (not by fixed 24h steps) so 23h/25h DST days
	// produce neither duplicate nor skipped dateKeys.
	const keys: string[] = [];
	const cursor = new Date(start);
	while (cursor.getTime() <= now) {
		keys.push(dateKey(cursor.getTime()));
		cursor.setDate(cursor.getDate() + 1);
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
	const from = rangeDays > 0 ? startOfDayDaysAgo(now, rangeDays - 1) : 0;
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
