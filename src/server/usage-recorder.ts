// Watches live task-session summaries and appends per-turn usage deltas to the workspace
// usage ledger (usage.jsonl). Cumulative usage from the session summary is diffed against
// the last seen cumulative value per (taskId, startedAt) run, so a row is written only for
// work done since the previous observation and restarts never double count.
// Baselines are purely in-memory (seeded from live summaries at track time), so ledger
// compaction in usage-ledger.ts never affects what this recorder writes.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { getWorkspaceUsagePath } from "../state/workspace-state";
import { appendUsageLedgerRow, type UsageLedgerRow } from "./usage-ledger";

export type { UsageLedgerRow };

interface RunBaseline {
	startedAt: number | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	turns: number;
	steps: number;
}

export interface UsageRecorder {
	/** Observe a live summary; writes a ledger row when usage grew since the last observation. */
	recordSummary(summary: RuntimeTaskSessionSummary): void;
	/**
	 * Capture the current cumulative usage as the baseline for a task without writing a row.
	 * Used when the runtime starts tracking a workspace so persisted history is never
	 * re-counted as fresh usage.
	 */
	seedSummary(summary: RuntimeTaskSessionSummary): void;
	/** Resolve when every queued append has finished (for tests and shutdown). */
	flush(): Promise<void>;
}

export function createUsageRecorder(
	workspaceId: string,
	appendRow: (path: string, row: UsageLedgerRow) => Promise<void> = appendUsageLedgerRow,
): UsageRecorder {
	const baselines = new Map<string, RunBaseline>();
	let queue: Promise<void> = Promise.resolve();

	const recordSummary = (summary: RuntimeTaskSessionSummary): void => {
		const usage = summary.usage;
		if (!usage) {
			return;
		}
		const previous = baselines.get(summary.taskId) ?? null;
		const isNewRun = previous !== null && previous.startedAt !== summary.startedAt;
		const baseline: RunBaseline = previous && !isNewRun ? previous : nullBaseline(summary.startedAt);
		// A decrease without a run change means the SDK restarted its own totals:
		// reseat the baseline silently instead of writing a negative or bogus row.
		const decreased =
			!isNewRun &&
			previous !== null &&
			usage.inputTokens < previous.inputTokens &&
			usage.outputTokens < previous.outputTokens;
		baselines.set(summary.taskId, toBaseline(summary));
		if (decreased) {
			return;
		}
		const row: UsageLedgerRow = {
			ts: Date.now(),
			taskId: summary.taskId,
			agentId: summary.agentId,
			modelId: summary.modelId,
			inputTokens: Math.max(0, usage.inputTokens - baseline.inputTokens),
			outputTokens: Math.max(0, usage.outputTokens - baseline.outputTokens),
			cacheReadTokens: Math.max(0, usage.cacheReadTokens - baseline.cacheReadTokens),
			cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - baseline.cacheWriteTokens),
			costUsd: Math.max(0, (usage.costUsd ?? 0) - baseline.costUsd) || null,
			turns: Math.max(0, usage.turns - baseline.turns),
			steps: Math.max(0, usage.steps - baseline.steps),
		};
		const hasSignal =
			row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0 ||
			row.turns > 0 ||
			row.steps > 0 ||
			row.costUsd !== null;
		if (!hasSignal) {
			return;
		}
		queue = queue
			.then(() => appendRow(getWorkspaceUsagePath(workspaceId), row))
			.catch(() => {
				// Ledger failures must never break the session stream; stats degrade to missing days.
			});
	};

	return {
		recordSummary,
		seedSummary: (summary) => {
			if (!summary.usage) {
				return;
			}
			baselines.set(summary.taskId, toBaseline(summary));
		},
		flush: () => queue,
	};
}

function toBaseline(summary: RuntimeTaskSessionSummary): RunBaseline {
	return {
		startedAt: summary.startedAt,
		inputTokens: summary.usage?.inputTokens ?? 0,
		outputTokens: summary.usage?.outputTokens ?? 0,
		cacheReadTokens: summary.usage?.cacheReadTokens ?? 0,
		cacheWriteTokens: summary.usage?.cacheWriteTokens ?? 0,
		costUsd: summary.usage?.costUsd ?? 0,
		turns: summary.usage?.turns ?? 0,
		steps: summary.usage?.steps ?? 0,
	};
}

function nullBaseline(startedAt: number | null): RunBaseline {
	return {
		startedAt,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		turns: 0,
		steps: 0,
	};
}
