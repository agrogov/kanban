import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { listWorkspaceIndexEntries, loadWorkspaceState, saveWorkspaceState } from "../state/workspace-state";
import { removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { WorkspaceRegistry } from "./workspace-registry";
import { collectProjectWorktreeTaskIdsForRemoval } from "./workspace-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	workspaceRegistry: Pick<WorkspaceRegistry, "listManagedWorkspaces">;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	skipSessionCleanup?: boolean;
}

// Shutdown only marks sessions as interrupted. Cards stay in their column and their worktrees stay on disk,
// so committed and uncommitted task work survives a restart and the user can resume the task.
//
// Only a turn that was actually in flight (`running`) can be interrupted. `awaiting_review` is the
// completed state and `idle`/`failed` are durable outcomes, so those records are left untouched:
// overwriting them would make a finished task read and behave as interrupted after the restart
// (the UI auto-trashes cards whose session turns `interrupted`).
async function persistInterruptedSessions(
	workspacePath: string,
	interruptedTaskIds: string[],
	options?: {
		workspaceState?: RuntimeWorkspaceStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	},
): Promise<void> {
	if (interruptedTaskIds.length === 0) {
		return;
	}
	const workspaceState = options?.workspaceState ?? (await loadWorkspaceState(workspacePath));
	const nextSessions = {
		...workspaceState.sessions,
	};
	for (const taskId of interruptedTaskIds) {
		const summary = options?.resolveSummary?.(taskId) ?? workspaceState.sessions[taskId] ?? null;
		// The exit handler may already have flipped the live summary to `interrupted` while the
		// PTY was killed, so that state is interruptible too. Anything else (`awaiting_review`,
		// `idle`, `failed`) is a finished outcome and must not be downgraded to interrupted.
		if (!summary || !isInterruptibleSessionState(summary.state)) {
			continue;
		}
		nextSessions[taskId] = {
			...summary,
			state: "interrupted",
			reviewReason: "interrupted",
			pid: null,
			updatedAt: Date.now(),
		};
	}
	await saveWorkspaceState(workspacePath, {
		board: workspaceState.board,
		sessions: nextSessions,
	});
}

async function cleanupTaskWorktreeSetupLocks(
	repoPaths: Iterable<string>,
	warn: (message: string) => void,
): Promise<void> {
	await Promise.all(
		Array.from(new Set(repoPaths)).map(async (repoPath) => {
			try {
				await removeTaskWorktreeSetupLock(repoPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not remove task worktree setup lock for ${repoPath} during shutdown cleanup. ${message}`);
			}
		}),
	);
}

// Only a turn that was actually in flight can be interrupted. `awaiting_review` is the completed
// state and `idle`/`failed` are durable outcomes, so they never become `interrupted` on shutdown.
function isInterruptibleSessionState(state: RuntimeTaskSessionSummary["state"]): boolean {
	return state === "running" || state === "interrupted";
}

function isTurnInFlightOnShutdown(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "running";
}

function collectShutdownInterruptedTaskIds(
	summariesBeforeStop: RuntimeTaskSessionSummary[],
	stoppedSummaries: RuntimeTaskSessionSummary[],
): string[] {
	const taskIds = new Set<string>();
	for (const summary of [...summariesBeforeStop, ...stoppedSummaries]) {
		if (isTurnInFlightOnShutdown(summary)) {
			taskIds.add(summary.taskId);
		}
	}
	return Array.from(taskIds);
}

// Cards in a work column can keep a persisted `running` summary after their runtime entry is gone
// (crash, forced quit, a restart that lost the live session). Those turns were still in flight when
// they stopped, so they are interruptible and resumable. The state check is what keeps the other
// work-column cards (finished review cards, idle sessions) untouched.
function collectInFlightWorkColumnTaskIds(workspaceState: RuntimeWorkspaceStateResponse): string[] {
	const taskIds: string[] = [];
	for (const taskId of collectProjectWorktreeTaskIdsForRemoval(workspaceState.board)) {
		const summary = workspaceState.sessions[taskId];
		if (summary && isTurnInFlightOnShutdown(summary)) {
			taskIds.push(taskId);
		}
	}
	return taskIds;
}

export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	if (deps.skipSessionCleanup) {
		await deps.closeRuntimeServer();
		return;
	}

	const interruptedByWorkspace: Array<{
		workspacePath: string;
		interruptedTaskIds: string[];
		workspaceState?: RuntimeWorkspaceStateResponse;
		resolveSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
	}> = [];
	const managedWorkspacePaths = new Set<string>();

	for (const { workspacePath, terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
		// Snapshot before stopping: killing a session asynchronously flips its live summary to
		// `interrupted`, which would hide which turns were actually in flight.
		const summariesBeforeStop = terminalManager.listSummaries();
		const stoppedSummaries = terminalManager.markInterruptedAndStopAll();
		if (!workspacePath) {
			continue;
		}
		managedWorkspacePaths.add(workspacePath);
		try {
			const workspaceState = await loadWorkspaceState(workspacePath);
			const interruptedTaskIds = new Set(collectShutdownInterruptedTaskIds(summariesBeforeStop, stoppedSummaries));
			for (const taskId of collectInFlightWorkColumnTaskIds(workspaceState)) {
				interruptedTaskIds.add(taskId);
			}
			interruptedByWorkspace.push({
				workspacePath,
				interruptedTaskIds: Array.from(interruptedTaskIds),
				workspaceState,
				resolveSummary: (taskId) => terminalManager.getSummary(taskId),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspacePath} during shutdown cleanup. ${message}`);
		}
	}

	const indexedWorkspaces = await listWorkspaceIndexEntries();
	for (const workspace of indexedWorkspaces) {
		if (managedWorkspacePaths.has(workspace.repoPath)) {
			continue;
		}
		try {
			const workspaceState = await loadWorkspaceState(workspace.repoPath);
			const interruptedTaskIds = collectInFlightWorkColumnTaskIds(workspaceState);
			if (interruptedTaskIds.length === 0) {
				continue;
			}
			interruptedByWorkspace.push({
				workspacePath: workspace.repoPath,
				interruptedTaskIds,
				workspaceState,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not load workspace state for ${workspace.repoPath} during shutdown cleanup. ${message}`);
		}
	}

	await Promise.all(
		interruptedByWorkspace.map(async (workspace) => {
			await persistInterruptedSessions(workspace.workspacePath, workspace.interruptedTaskIds, {
				workspaceState: workspace.workspaceState,
				resolveSummary: workspace.resolveSummary,
			});
		}),
	);

	await deps.closeRuntimeServer();

	await cleanupTaskWorktreeSetupLocks(
		[...managedWorkspacePaths, ...indexedWorkspaces.map((workspace) => workspace.repoPath)],
		deps.warn,
	);
}
