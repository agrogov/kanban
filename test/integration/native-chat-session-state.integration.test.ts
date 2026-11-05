import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ClineTaskSessionService } from "../../src/cline-sdk/cline-task-session-service";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../src/server/runtime-state-hub";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import { saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
	}
}

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
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

function createBoardWithInProgressCard(taskId: string): RuntimeBoardData {
	const now = Date.now();
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: taskId,
						title: "Edit files",
						prompt: "Edit five files",
						startInPlanMode: false,
						baseRef: "main",
						createdAt: now,
						updatedAt: now,
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSessionSummary(
	taskId: string,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	const now = Date.now();
	return {
		taskId,
		state: "running",
		agentId: "pi-chat",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: now,
		updatedAt: now,
		lastOutputAt: now,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

/** Minimal stand-in for the native-chat backends the hub tracks. */
function createFakeChatService(initialSummaries: RuntimeTaskSessionSummary[]): {
	service: ClineTaskSessionService;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
} {
	const summariesByTaskId = new Map(initialSummaries.map((summary) => [summary.taskId, summary]));
	const summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const service = {
		listSummaries: () => Array.from(summariesByTaskId.values()),
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			summaryListeners.add(listener);
			return () => {
				summaryListeners.delete(listener);
			};
		},
		onMessage: () => () => {},
	} as unknown as ClineTaskSessionService;
	return {
		service,
		emitSummary: (summary) => {
			summariesByTaskId.set(summary.taskId, summary);
			for (const listener of summaryListeners) {
				listener(summary);
			}
		},
	};
}

describe.sequential("native-chat session visibility in workspace state", () => {
	it("serves live native-chat summaries from workspace.getState", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-native-chat-state-");
			let hub: RuntimeStateHub | undefined;
			try {
				const repoPath = join(sandboxRoot, "repo");
				mkdirSync(repoPath, { recursive: true });
				runGit(repoPath, ["init"]);
				runGit(repoPath, ["config", "user.name", "Kanban Test"]);
				runGit(repoPath, ["config", "user.email", "kanban-test@example.com"]);
				runGit(repoPath, ["commit", "--allow-empty", "-m", "init"]);

				const taskId = "task-native-chat";
				await saveWorkspaceState(repoPath, {
					board: createBoardWithInProgressCard(taskId),
					sessions: {},
					expectedRevision: 0,
				});

				const workspaceRegistry = await createWorkspaceRegistry({
					cwd: repoPath,
					loadGlobalRuntimeConfig,
					loadRuntimeConfig,
					hasGitRepository: () => true,
					pathIsDirectory: async () => true,
					listClineTaskSessionSummaries: (workspaceId) => hub?.listClineTaskSessionSummaries(workspaceId) ?? [],
				});
				hub = createRuntimeStateHub({ workspaceRegistry });
				const workspaceId = workspaceRegistry.getActiveWorkspaceId();
				expect(workspaceId).not.toBeNull();
				if (!workspaceId) {
					throw new Error("Expected an active workspace id.");
				}

				// Reproduces the bug: before the hub tracks the service, the running
				// native-chat session is invisible.
				const before = await workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, repoPath);
				expect(before.sessions[taskId]).toBeUndefined();

				const { service, emitSummary } = createFakeChatService([
					createSessionSummary(taskId, { state: "running", agentId: "pi-chat" }),
				]);
				hub.trackClineTaskSessionService(workspaceId, repoPath, service);

				const running = await workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, repoPath);
				expect(running.sessions[taskId]).toMatchObject({ state: "running", agentId: "pi-chat" });

				emitSummary(
					createSessionSummary(taskId, {
						state: "awaiting_review",
						reviewReason: "hook",
						updatedAt: Date.now() + 1,
					}),
				);

				const reviewed = await workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, repoPath);
				expect(reviewed.sessions[taskId]).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
			} finally {
				await hub?.close();
				cleanup();
			}
		});
	});
});
