import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-shutdown-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(
	taskId: string,
	state: "running" | "awaiting_review" | "idle",
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	const lastHookAt = Date.now() - 500;
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: state === "awaiting_review" ? lastHookAt : null,
		latestHookActivity:
			state === "awaiting_review"
				? {
						activityText: "Turn complete",
						toolName: null,
						toolInputSummary: null,
						finalMessage: "Landed cleanly on the task branch.",
						hookEventName: null,
						notificationType: null,
						source: null,
					}
				: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it("keeps cards in place, interrupts in-flight turns, and preserves finished turns on shutdown", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-scope-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedInitial = await loadWorkspaceState(managedProjectPath);
				await saveWorkspaceState(managedProjectPath, {
					board: createBoard({
						inProgress: ["managed-running", "managed-stale-running", "managed-missing-session"],
						review: ["managed-idle", "managed-awaiting-review"],
					}),
					sessions: {
						"managed-running": createSession("managed-running", "running"),
						// Persisted as running, but the runtime no longer holds a live summary for it.
						"managed-stale-running": createSession("managed-stale-running", "running"),
						"managed-idle": createSession("managed-idle", "idle"),
						"managed-awaiting-review": createSession("managed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: managedInitial.revision,
				});

				const indexedInitial = await loadWorkspaceState(indexedProjectPath);
				await saveWorkspaceState(indexedProjectPath, {
					board: createBoard({
						inProgress: ["indexed-running", "indexed-missing-session"],
						review: ["indexed-awaiting-review"],
					}),
					sessions: {
						"indexed-running": createSession("indexed-running", "running"),
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});

				let didCloseRuntimeServer = false;
				// Mirrors the real runtime: `markInterruptedAndStopAll` kills the PTY and the exit
				// handler asynchronously rewrites the live summary to `interrupted`.
				let didStopManagedSessions = false;
				const liveManagedSummaries = (): RuntimeTaskSessionSummary[] => {
					if (!didStopManagedSessions) {
						return [createSession("managed-running", "running")];
					}
					return [
						{
							...createSession("managed-running", "running"),
							state: "interrupted",
							reviewReason: "interrupted",
							pid: null,
						},
					];
				};
				const managedTerminalManager = {
					markInterruptedAndStopAll: () => {
						const stopped = liveManagedSummaries();
						didStopManagedSessions = true;
						return stopped;
					},
					listSummaries: () => liveManagedSummaries(),
					getSummary: (taskId: string) => {
						if (taskId === "managed-running") {
							return liveManagedSummaries()[0] ?? null;
						}
						if (taskId === "managed-idle") {
							return createSession("managed-idle", "idle");
						}
						return null;
					},
				} as unknown as TerminalSessionManager;
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "managed-project",
								// Canonical path, as the registry stores it, so the indexed-workspace pass skips it.
								workspacePath: realpathSync(managedProjectPath),
								terminalManager: managedTerminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(didCloseRuntimeServer).toBe(true);

				const managedAfter = await loadWorkspaceState(managedProjectPath);
				const columnOf = (board: typeof managedAfter.board, id: string) =>
					board.columns.find((column) => column.cards.some((card) => card.id === id))?.id;
				expect(columnOf(managedAfter.board, "managed-running")).toBe("in_progress");
				expect(columnOf(managedAfter.board, "managed-idle")).toBe("review");
				expect(columnOf(managedAfter.board, "managed-missing-session")).toBe("in_progress");

				// A turn that was actually in flight becomes resumable, from the live runtime...
				expect(managedAfter.sessions["managed-running"]?.state).toBe("interrupted");
				expect(managedAfter.sessions["managed-running"]?.reviewReason).toBe("interrupted");
				// ...and from a persisted `running` summary whose runtime entry is already gone.
				expect(managedAfter.sessions["managed-stale-running"]?.state).toBe("interrupted");
				expect(managedAfter.sessions["managed-stale-running"]?.reviewReason).toBe("interrupted");

				// `awaiting_review` is the completed state: it must survive a restart unchanged so a
				// finished task still reads as finished instead of being auto-trashed on load.
				const managedAwaitingReview = managedAfter.sessions["managed-awaiting-review"];
				expect(managedAwaitingReview?.state).toBe("awaiting_review");
				expect(managedAwaitingReview?.reviewReason).toBe("hook");
				expect(managedAwaitingReview?.lastHookAt).not.toBeNull();
				expect(managedAwaitingReview?.latestHookActivity?.activityText).toBe("Turn complete");
				expect(managedAwaitingReview?.latestHookActivity?.finalMessage).toBe("Landed cleanly on the task branch.");
				// `idle` and `failed` are durable outcomes too, not interruptions.
				expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");
				expect(managedAfter.sessions["managed-idle"]?.reviewReason).toBeNull();
				expect(managedAfter.sessions["managed-missing-session"]).toBeUndefined();

				const indexedAfter = await loadWorkspaceState(indexedProjectPath);
				expect(columnOf(indexedAfter.board, "indexed-awaiting-review")).toBe("review");
				expect(columnOf(indexedAfter.board, "indexed-missing-session")).toBe("in_progress");
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("awaiting_review");
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.reviewReason).toBe("hook");
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.latestHookActivity?.finalMessage).toBe(
					"Landed cleanly on the task branch.",
				);
				expect(indexedAfter.sessions["indexed-running"]?.state).toBe("interrupted");
				expect(indexedAfter.sessions["indexed-missing-session"]).toBeUndefined();
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
