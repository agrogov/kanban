import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "./api-contract";

/**
 * States in which an agent process may still be attached to the task worktree.
 *
 * `awaiting_review` counts as live: native-chat backends and hook-driven agents
 * keep their transport (and sometimes their turn) alive while waiting for the
 * user, so starting another agent then would write into the same worktree.
 * `idle` is not live — it means a session entry exists but no turn was started.
 *
 * This is the single definition of liveness for the whole runtime. Every backend
 * (terminal PTY, Cline SDK, native chat) uses it to decide whether a start request
 * is a no-op, and the CLI and workspace registry use it to decide what to report.
 */
const LIVE_TASK_SESSION_STATES: ReadonlySet<RuntimeTaskSessionState> = new Set(["running", "awaiting_review"]);

export function isLiveTaskSessionState(state: RuntimeTaskSessionState | null | undefined): boolean {
	return state != null && LIVE_TASK_SESSION_STATES.has(state);
}

/** True when no agent can still be writing into the task worktree. */
export function isTerminalTaskSessionState(state: RuntimeTaskSessionState | null | undefined): boolean {
	return !isLiveTaskSessionState(state);
}

export function isLiveTaskSessionSummary(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return isLiveTaskSessionState(summary?.state);
}

/**
 * Picks the summary that best describes what a task is doing right now.
 *
 * Reconciles two *live* sources that describe the same task (the terminal manager
 * and the native-chat service): a live summary beats a finished one, and the most
 * recently updated summary wins between equally live candidates.
 *
 * Do not use this to merge a persisted summary with a live one. A live summary
 * describes the process that exists right now, so it wins outright; a stale
 * persisted `running` record must not be able to outrank it.
 */
export function selectPreferredTaskSessionSummary(
	current: RuntimeTaskSessionSummary | null | undefined,
	candidate: RuntimeTaskSessionSummary | null | undefined,
): RuntimeTaskSessionSummary | null {
	if (!current) {
		return candidate ?? null;
	}
	if (!candidate) {
		return current;
	}
	const currentIsLive = isLiveTaskSessionSummary(current);
	const candidateIsLive = isLiveTaskSessionSummary(candidate);
	if (currentIsLive !== candidateIsLive) {
		return candidateIsLive ? candidate : current;
	}
	return candidate.updatedAt >= current.updatedAt ? candidate : current;
}

export type TaskSessionSummaryMap = Record<string, RuntimeTaskSessionSummary>;

/**
 * Collapses summaries from every backend that can hold a live session (the terminal manager
 * and the native-chat service) into one authoritative entry per task.
 */
export function reconcileLiveTaskSessionSummaries(
	summaries: Iterable<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary[] {
	const byTaskId = new Map<string, RuntimeTaskSessionSummary>();
	for (const summary of summaries) {
		byTaskId.set(summary.taskId, selectPreferredTaskSessionSummary(byTaskId.get(summary.taskId), summary) ?? summary);
	}
	return Array.from(byTaskId.values());
}

/**
 * Overlays the live view on top of the persisted one, where live wins outright.
 *
 * A live summary describes the process attached to the worktree right now, so it must not be
 * weighed against the persisted record: a stale `running` left behind by a crash or a closed
 * app would otherwise outrank a backend that has since gone idle, and callers that gate on
 * liveness (`task start`) would refuse to launch even though no agent is attached.
 */
export function overlayLiveTaskSessions(
	persisted: TaskSessionSummaryMap,
	liveSummaries: Iterable<RuntimeTaskSessionSummary>,
): TaskSessionSummaryMap {
	const next: TaskSessionSummaryMap = { ...persisted };
	for (const summary of liveSummaries) {
		next[summary.taskId] = summary;
	}
	return next;
}
