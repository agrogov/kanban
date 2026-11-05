import { afterEach, describe, expect, it, vi } from "vitest";

import {
	buildTaskAgentSettingsForCreate,
	buildTaskAgentSettingsForUpdate,
	formatTaskAgentSettings,
	type MoveTaskDependencies,
	moveTask,
	resolveSettingsFlag,
	type StartTaskDependencies,
	shouldWarnOnExplicitAgentId,
	startTask,
	warnOnAgentSettingsMechanismGaps,
} from "../../src/commands/task";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";

describe("buildTaskAgentSettingsForCreate", () => {
	it("returns undefined when no settings fields are provided", () => {
		expect(buildTaskAgentSettingsForCreate({})).toBeUndefined();
	});

	it("stores opaque values verbatim without validation", () => {
		expect(
			buildTaskAgentSettingsForCreate({
				providerId: "moonshot",
				modelId: "kimi-k2-0905-preview",
				reasoningEffort: "ultracode",
			}),
		).toEqual({
			providerId: "moonshot",
			modelId: "kimi-k2-0905-preview",
			reasoningEffort: "ultracode",
		});
	});

	it("treats inherit (null) reasoning effort as no explicit override", () => {
		expect(buildTaskAgentSettingsForCreate({ reasoningEffort: null })).toBeUndefined();
	});

	it("treats default reasoning effort as an empty override marker", () => {
		expect(buildTaskAgentSettingsForCreate({ reasoningEffort: "default" })).toEqual({});
	});

	it("treats blank provider/model values as unset", () => {
		expect(buildTaskAgentSettingsForCreate({ providerId: "  ", modelId: "" })).toBeUndefined();
	});
});

describe("buildTaskAgentSettingsForUpdate", () => {
	const CURRENT: RuntimeTaskAgentSettings = {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-20250514",
		reasoningEffort: "high",
	};

	it("returns undefined when no settings fields are provided", () => {
		expect(buildTaskAgentSettingsForUpdate(CURRENT, {})).toBeUndefined();
	});

	it("merges new values over current settings", () => {
		expect(
			buildTaskAgentSettingsForUpdate(CURRENT, {
				modelId: "new-model",
				reasoningEffort: "ultrathink",
			}),
		).toEqual({
			providerId: "anthropic",
			modelId: "new-model",
			reasoningEffort: "ultrathink",
		});
	});

	it("clears a field with null/default and keeps the empty-override marker", () => {
		expect(
			buildTaskAgentSettingsForUpdate(
				{ modelId: "old-model" },
				{
					modelId: null,
					reasoningEffort: "default",
				},
			),
		).toEqual({});
	});

	it("clears everything with null/inherit and returns null", () => {
		expect(
			buildTaskAgentSettingsForUpdate(CURRENT, {
				providerId: null,
				modelId: null,
				reasoningEffort: null,
			}),
		).toBeNull();
	});

	it("accepts arbitrary effort strings on update (opacity proof)", () => {
		expect(buildTaskAgentSettingsForUpdate(undefined, { reasoningEffort: "MAXIMUM_OVERDRIVE" })).toEqual({
			reasoningEffort: "MAXIMUM_OVERDRIVE",
		});
	});
});

describe("shouldWarnOnExplicitAgentId", () => {
	it("is true only when the command names an agent", () => {
		expect(shouldWarnOnExplicitAgentId("kiro")).toBe(true);
		expect(shouldWarnOnExplicitAgentId(undefined)).toBe(false);
		expect(shouldWarnOnExplicitAgentId(null)).toBe(false);
	});
});

describe("warnOnAgentSettingsMechanismGaps", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function captureStderr(): ReturnType<typeof vi.fn> {
		return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	}

	it("writes no warning when settings are absent", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("kiro", undefined);
		expect(write).not.toHaveBeenCalled();
	});

	it("writes no warning for agents that support the set fields", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("claude", { modelId: "m", reasoningEffort: "high" });
		warnOnAgentSettingsMechanismGaps("codex", { modelId: "m", reasoningEffort: "high" });
		warnOnAgentSettingsMechanismGaps("droid", { modelId: "m", reasoningEffort: "high" });
		warnOnAgentSettingsMechanismGaps("cline", { providerId: "anthropic", modelId: "m", reasoningEffort: "high" });
		warnOnAgentSettingsMechanismGaps("opencode", { providerId: "openrouter", modelId: "m" });
		expect(write).not.toHaveBeenCalled();
	});

	it("warns when kiro receives model, effort, or provider settings", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("kiro", {
			providerId: "anthropic",
			modelId: "some-model",
			reasoningEffort: "high",
		});
		const output = write.mock.calls.map((call) => String(call[0])).join("");
		expect(output).toContain("some-model");
		expect(output).toContain("high");
		expect(output).toContain("anthropic");
	});

	it("warns when gemini receives a reasoning effort setting", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("gemini", { reasoningEffort: "high" });
		const output = write.mock.calls.map((call) => String(call[0])).join("");
		expect(output).toContain("high");
		expect(output).toContain("Gemini CLI");
	});

	it("does not warn for gemini model settings", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("gemini", { modelId: "gemini-2.5-pro" });
		expect(write).not.toHaveBeenCalled();
	});

	it("warns when a provider is set for an agent that never reads it", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("claude", { providerId: "anthropic" });
		const output = write.mock.calls.map((call) => String(call[0])).join("");
		expect(output).toContain("anthropic");
		expect(output).toContain("provider");
	});

	it("does not warn for provider on agents that read one (cline/opencode)", () => {
		const write = captureStderr();
		warnOnAgentSettingsMechanismGaps("cline", { providerId: "anthropic" });
		warnOnAgentSettingsMechanismGaps("opencode", { providerId: "openrouter" });
		expect(write).not.toHaveBeenCalled();
	});
});

describe("resolveSettingsFlag", () => {
	it("returns the generic flag when only it is set", () => {
		expect(resolveSettingsFlag("generic", undefined, "--model", "--cline-model")).toBe("generic");
	});

	it("returns the deprecated alias when only it is set", () => {
		expect(resolveSettingsFlag(undefined, "alias", "--model", "--cline-model")).toBe("alias");
	});

	it("throws when both forms are passed for the same field", () => {
		expect(() => resolveSettingsFlag("generic", "alias", "--model", "--cline-model")).toThrow(
			"Cannot use both --model and the deprecated --cline-model",
		);
	});
});

describe("formatTaskAgentSettings", () => {
	it("emits agentSettings plus a deprecated clineSettings mirror", () => {
		expect(formatTaskAgentSettings({ modelId: "acme-model" })).toEqual({
			agentSettings: { modelId: "acme-model" },
			clineSettings: { modelId: "acme-model" },
		});
	});

	it("emits an empty object when settings are absent", () => {
		expect(formatTaskAgentSettings(undefined)).toEqual({});
	});
});

function createTaskSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "pi-chat",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
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

function createStartTaskState(session: RuntimeTaskSessionSummary | null): RuntimeWorkspaceStateResponse {
	const now = Date.now();
	const card: RuntimeBoardCard = {
		id: "task-1",
		title: "Write files",
		prompt: "Edit five files",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: now,
		updatedAt: now,
	};
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/repo/.kanban/state.json",
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [card] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		},
		sessions: session ? { "task-1": session } : {},
		revision: 1,
	};
}

interface StartTaskHarness {
	dependencies: StartTaskDependencies;
	startTaskSession: ReturnType<typeof vi.fn>;
	ensureWorktree: ReturnType<typeof vi.fn>;
}

/** Builds fakes for the two state reads (initial + pre-launch re-check) `startTask` performs. */
function createStartTaskHarness(states: RuntimeWorkspaceStateResponse[]): StartTaskHarness {
	let readIndex = 0;
	const getState = vi.fn(async () => {
		const state = states[Math.min(readIndex, states.length - 1)];
		readIndex += 1;
		return state;
	});
	const ensureWorktree = vi.fn(async () => ({ ok: true }));
	const startTaskSession = vi.fn(async () => ({
		ok: true,
		summary: createTaskSummary({ state: "running", agentId: "claude-chat" }),
	}));
	const stopTaskSession = vi.fn();
	const runtimeClient = {
		workspace: {
			getState: { query: getState },
			ensureWorktree: { mutate: ensureWorktree },
		},
		runtime: {
			startTaskSession: { mutate: startTaskSession },
			stopTaskSession: { mutate: stopTaskSession },
		},
	};
	const dependencies = {
		resolveWorkspaceRepoPath: async () => "/tmp/repo",
		ensureRuntimeWorkspace: async () => "workspace-1",
		createRuntimeClient: () => runtimeClient as never,
		updateRuntimeWorkspaceState: async (_client, _repoPath, mutate) => mutate(states[states.length - 1]).value,
	} satisfies StartTaskDependencies;
	return { dependencies, startTaskSession, ensureWorktree };
}

describe("startTask", () => {
	it("refuses to start a task whose native-chat session is still running", async () => {
		const harness = createStartTaskHarness([
			createStartTaskState(createTaskSummary({ state: "running", agentId: "pi-chat" })),
		]);

		await expect(startTask({ cwd: "/tmp/repo", taskId: "task-1" }, harness.dependencies)).rejects.toThrow(
			/already in progress with a live session/,
		);
		expect(harness.ensureWorktree).not.toHaveBeenCalled();
		expect(harness.startTaskSession).not.toHaveBeenCalled();
	});

	it("refuses to start a task awaiting review, since the agent may still be attached", async () => {
		const harness = createStartTaskHarness([
			createStartTaskState(createTaskSummary({ state: "awaiting_review", agentId: "claude-chat" })),
		]);

		await expect(startTask({ cwd: "/tmp/repo", taskId: "task-1" }, harness.dependencies)).rejects.toThrow(
			/already in progress with a live session/,
		);
		expect(harness.startTaskSession).not.toHaveBeenCalled();
	});

	it("re-checks state right before launch and aborts when a session appeared meanwhile", async () => {
		const harness = createStartTaskHarness([
			createStartTaskState(null),
			createStartTaskState(createTaskSummary({ state: "running", agentId: "pi-chat" })),
		]);

		await expect(startTask({ cwd: "/tmp/repo", taskId: "task-1" }, harness.dependencies)).rejects.toThrow(
			/already in progress with a live session/,
		);
		expect(harness.ensureWorktree).toHaveBeenCalledTimes(1);
		expect(harness.startTaskSession).not.toHaveBeenCalled();
	});

	it("starts the task when the existing session is terminal", async () => {
		const harness = createStartTaskHarness([
			createStartTaskState(createTaskSummary({ state: "interrupted", reviewReason: "interrupted" })),
		]);

		await startTask({ cwd: "/tmp/repo", taskId: "task-1" }, harness.dependencies);

		expect(harness.startTaskSession).toHaveBeenCalledTimes(1);
	});
});

interface MoveTaskHarness {
	dependencies: MoveTaskDependencies;
	getMutationCount: () => number;
	stopTaskSession: ReturnType<typeof vi.fn>;
	trashTask: ReturnType<typeof vi.fn>;
}

function createBoardStateWithTaskInColumn(columnId: RuntimeBoardColumnId): RuntimeWorkspaceStateResponse {
	const base = createStartTaskState(null);
	const card = base.board.columns.find((column) => column.id === "in_progress")?.cards[0];
	if (!card) {
		throw new Error("Expected a fixture card in in_progress.");
	}
	return {
		...base,
		board: {
			...base.board,
			columns: base.board.columns.map((column) => ({
				...column,
				cards: column.id === columnId ? [card] : [],
			})),
		},
	};
}

function createMoveTaskHarness(state: RuntimeWorkspaceStateResponse): MoveTaskHarness {
	let mutationCount = 0;
	const stopTaskSession = vi.fn(async () => ({ ok: true }));
	const runtimeClient = {
		workspace: { getState: { query: vi.fn(async () => state) } },
		runtime: { stopTaskSession: { mutate: stopTaskSession } },
	};
	const trashTask = vi.fn(async () => ({
		ok: true,
		task: { id: "task-1", column: "trash" },
		workspacePath: "/tmp/repo",
	}));
	const dependencies = {
		resolveWorkspaceRepoPath: async () => "/tmp/repo",
		ensureRuntimeWorkspace: async () => "workspace-1",
		createRuntimeClient: () => runtimeClient as never,
		updateRuntimeWorkspaceState: async (_client, _repoPath, mutate) => {
			mutationCount += 1;
			return mutate(state).value;
		},
		trashTask,
	} satisfies MoveTaskDependencies;
	return { dependencies, getMutationCount: () => mutationCount, stopTaskSession, trashTask };
}

describe("moveTask", () => {
	it("requeues a task from in_progress to backlog and reports the new column", async () => {
		const harness = createMoveTaskHarness(createBoardStateWithTaskInColumn("in_progress"));

		const result = await moveTask({ cwd: "/tmp/repo", taskId: "task-1", column: "backlog" }, harness.dependencies);

		expect(result).toMatchObject({ ok: true, workspacePath: "/tmp/repo" });
		expect(result.task).toMatchObject({ id: "task-1", column: "backlog" });
		expect(harness.getMutationCount()).toBe(1);
		expect(harness.stopTaskSession).not.toHaveBeenCalled();
	});

	it("stops a live session when requeueing to backlog", async () => {
		const state = createBoardStateWithTaskInColumn("in_progress");
		state.sessions["task-1"] = createTaskSummary({ state: "running", agentId: "pi-chat" });
		const harness = createMoveTaskHarness(state);

		await moveTask({ cwd: "/tmp/repo", taskId: "task-1", column: "backlog" }, harness.dependencies);

		expect(harness.stopTaskSession).toHaveBeenCalledWith({ taskId: "task-1" });
	});

	it("rejects a transition the UI does not allow without touching the board", async () => {
		const harness = createMoveTaskHarness(createBoardStateWithTaskInColumn("backlog"));

		await expect(
			moveTask({ cwd: "/tmp/repo", taskId: "task-1", column: "review" }, harness.dependencies),
		).rejects.toThrow('cannot move from "backlog" to "review"');
		expect(harness.getMutationCount()).toBe(0);
	});

	it("routes done moves through the trash workflow", async () => {
		const harness = createMoveTaskHarness(createBoardStateWithTaskInColumn("in_progress"));

		const result = await moveTask({ cwd: "/tmp/repo", taskId: "task-1", column: "trash" }, harness.dependencies);

		expect(harness.trashTask).toHaveBeenCalledWith({
			cwd: "/tmp/repo",
			taskId: "task-1",
			projectPath: undefined,
		});
		expect(result).toMatchObject({ ok: true, workspacePath: "/tmp/repo" });
	});
});
