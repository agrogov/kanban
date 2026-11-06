import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionState, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	isLiveTaskSessionState,
	isTerminalTaskSessionState,
	overlayLiveTaskSessions,
	reconcileLiveTaskSessionSummaries,
	selectPreferredTaskSessionSummary,
} from "../../../src/core/task-session-state";

function createSummary(
	taskId: string,
	state: RuntimeTaskSessionState,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: 1_000,
		updatedAt: 1_000,
		lastOutputAt: null,
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

describe("liveness", () => {
	it("counts a session with an agent attached to the worktree as live", () => {
		expect(isLiveTaskSessionState("running")).toBe(true);
		expect(isLiveTaskSessionState("awaiting_review")).toBe(true);
	});

	it("counts every other state as terminal, including a missing one", () => {
		for (const state of ["idle", "interrupted", "failed", null, undefined] as const) {
			expect(isLiveTaskSessionState(state), `expected "${state}" to be terminal`).toBe(false);
			expect(isTerminalTaskSessionState(state)).toBe(true);
		}
	});
});

describe("selectPreferredTaskSessionSummary", () => {
	it("prefers a live summary over a finished one regardless of recency", () => {
		const finished = createSummary("task-1", "interrupted", { updatedAt: 5_000 });
		const live = createSummary("task-1", "running", { updatedAt: 1_000 });
		expect(selectPreferredTaskSessionSummary(finished, live)).toBe(live);
		expect(selectPreferredTaskSessionSummary(live, finished)).toBe(live);
	});

	it("prefers the newer summary between two equally live candidates", () => {
		const older = createSummary("task-1", "running", { agentId: "codex", updatedAt: 1_000 });
		const newer = createSummary("task-1", "awaiting_review", { agentId: "pi-chat", updatedAt: 2_000 });
		expect(selectPreferredTaskSessionSummary(older, newer)).toBe(newer);
		expect(selectPreferredTaskSessionSummary(newer, older)).toBe(newer);
	});
});

describe("reconcileLiveTaskSessionSummaries", () => {
	it("collapses the terminal and native-chat views into one entry per task", () => {
		const terminal = createSummary("task-1", "interrupted", { agentId: "claude", updatedAt: 1_000 });
		const chat = createSummary("task-1", "running", { agentId: "claude-chat", updatedAt: 900 });

		const reconciled = reconcileLiveTaskSessionSummaries([terminal, chat, createSummary("task-2", "idle")]);

		expect(reconciled).toHaveLength(2);
		expect(reconciled.find((summary) => summary.taskId === "task-1")).toBe(chat);
	});
});

describe("overlayLiveTaskSessions", () => {
	it("lets a live summary replace a stale persisted one that claims a turn is in flight", () => {
		// The app closed while the card was running, so sessions.json still says `running`.
		// The backend has since come back as idle. Reporting the persisted record would make
		// `task start` refuse to launch even though no agent is attached to the worktree.
		const persisted = { "task-1": createSummary("task-1", "running", { updatedAt: 9_000 }) };
		const live = createSummary("task-1", "idle", { updatedAt: 1_000 });

		const merged = overlayLiveTaskSessions(persisted, [live]);

		expect(merged["task-1"]).toBe(live);
		expect(isTerminalTaskSessionState(merged["task-1"]?.state)).toBe(true);
	});

	it("leaves persisted summaries the runtime knows nothing about untouched", () => {
		const persisted = {
			"task-1": createSummary("task-1", "awaiting_review"),
			"task-2": createSummary("task-2", "running"),
		};

		const merged = overlayLiveTaskSessions(persisted, [createSummary("task-1", "running")]);

		expect(merged["task-1"]?.state).toBe("running");
		expect(merged["task-2"]).toBe(persisted["task-2"]);
	});

	it("does not mutate the persisted record it was given", () => {
		const persisted = { "task-1": createSummary("task-1", "running") };

		overlayLiveTaskSessions(persisted, [createSummary("task-1", "idle")]);

		expect(persisted["task-1"]?.state).toBe("running");
	});
});
