import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "./api-contract";

/**
 * States in which an agent process may still be attached to the task worktree.
 *
 * `awaiting_review` counts as live: native-chat backends and hook-driven agents
 * keep their transport (and sometimes their turn) alive while waiting for the
 * user, so starting another agent then would write into the same worktree.
 * `idle` is not live — it means a session entry exists but no turn was started.
 */
const LIVE_TASK_SESSION_STATES: ReadonlySet<RuntimeTaskSessionState> = new Set(["running", "awaiting_review"]);

function isLiveTaskSessionState(state: RuntimeTaskSessionState | null | undefined): boolean {
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
 * Used when several sources describe the same task (persisted state, terminal
 * manager, native-chat service): a live summary beats a finished one, and the
 * most recently updated summary wins between equally live candidates.
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
