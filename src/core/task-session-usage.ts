// Normalizes per-backend token/cost reports into the cumulative RuntimeTaskSessionUsage shape.
// Each chat backend reports usage differently (Cline emits per-request deltas, Claude reports
// session totals on result events, Codex reports per-turn totals, Pi reports per-message usage),
// so backend adapters convert their native shape into one delta here before touching a summary.
import type { RuntimeTaskSessionUsage } from "./api-contract";

export interface TaskSessionUsageUpdate {
	/** Fresh (non-cached) prompt tokens used since the last update. */
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	/** Incremental USD cost, only when the backend reports cost reliably. */
	costUsd?: number;
	turns?: number;
	steps?: number;
	/** Prompt size of the latest model call, when the backend can derive one. */
	contextTokens?: number;
	contextWindowTokens?: number;
	/** Latest-turn output rate in tokens per second. */
	outputTokensPerSecond?: number;
}

export interface TaskSessionUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd?: number | null;
}

export function createEmptyTaskSessionUsage(updatedAt: number): RuntimeTaskSessionUsage {
	return {
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
		updatedAt,
	};
}

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Sum of every token kind counted by the usage record. */
export function sumTaskSessionUsageTokens(usage: RuntimeTaskSessionUsage): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * Adds an update onto the session's cumulative usage. Token fields and turn/step counters
 * accumulate; context and rate fields replace the previous value when present. Backends that
 * report session totals must diff against the previously seen totals themselves so this
 * function only ever sees increments.
 */
export function applyTaskSessionUsageUpdate(
	previous: RuntimeTaskSessionUsage | null | undefined,
	update: TaskSessionUsageUpdate,
	updatedAt: number,
): RuntimeTaskSessionUsage {
	const base = previous ?? createEmptyTaskSessionUsage(updatedAt);
	const costDelta = typeof update.costUsd === "number" && update.costUsd > 0 ? update.costUsd : 0;
	const costUsd = costDelta > 0 || base.costUsd !== null ? (base.costUsd ?? 0) + costDelta : null;
	return {
		inputTokens: base.inputTokens + nonNegative(update.inputTokens ?? 0),
		outputTokens: base.outputTokens + nonNegative(update.outputTokens ?? 0),
		cacheReadTokens: base.cacheReadTokens + nonNegative(update.cacheReadTokens ?? 0),
		cacheWriteTokens: base.cacheWriteTokens + nonNegative(update.cacheWriteTokens ?? 0),
		costUsd,
		turns: base.turns + nonNegative(update.turns ?? 0),
		steps: base.steps + nonNegative(update.steps ?? 0),
		contextTokens:
			typeof update.contextTokens === "number" && update.contextTokens > 0
				? Math.round(update.contextTokens)
				: base.contextTokens,
		contextWindowTokens:
			typeof update.contextWindowTokens === "number" && update.contextWindowTokens > 0
				? Math.round(update.contextWindowTokens)
				: base.contextWindowTokens,
		outputTokensPerSecond:
			typeof update.outputTokensPerSecond === "number" && update.outputTokensPerSecond > 0
				? update.outputTokensPerSecond
				: base.outputTokensPerSecond,
		updatedAt,
	};
}

/**
 * Diffs cumulative session totals reported by a backend against the totals captured last
 * time, so total-style sources (Claude result events) can feed the same delta accumulator.
 * Negative results (provider reset, resumed session with a smaller baseline) clamp to zero.
 */
export function diffUsageTotals(
	previousTotals: TaskSessionUsageTotals | null,
	currentTotals: TaskSessionUsageTotals,
): TaskSessionUsageUpdate {
	const delta = (next: number, prev: number | null | undefined) => nonNegative(next - (prev ?? 0));
	return {
		inputTokens: delta(currentTotals.inputTokens, previousTotals?.inputTokens),
		outputTokens: delta(currentTotals.outputTokens, previousTotals?.outputTokens),
		cacheReadTokens: delta(currentTotals.cacheReadTokens, previousTotals?.cacheReadTokens),
		cacheWriteTokens: delta(currentTotals.cacheWriteTokens, previousTotals?.cacheWriteTokens),
		costUsd: delta(currentTotals.costUsd ?? 0, previousTotals?.costUsd),
	};
}

/** Converts cumulative token totals into an output rate over a wall-clock window. */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | undefined {
	if (outputTokens <= 0 || durationMs <= 0) {
		return undefined;
	}
	return (outputTokens / durationMs) * 1000;
}
