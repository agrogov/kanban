import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import type { AutoReviewCheckOutcome, RunAutoReviewCheckInput } from "../../../src/server/auto-review-check";
import type {
	AutoReviewTaskProbe,
	CreateAutoReviewReconcilerDependencies,
	TaskGitPromptTemplates,
} from "../../../src/server/auto-review-reconciler";
import { createAutoReviewReconciler } from "../../../src/server/auto-review-reconciler";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface StoredWorkspaceState {
	board: RuntimeBoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	revision: number;
}

function createCard(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: `Task ${overrides.id}`,
		prompt: `Do work for ${overrides.id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function createBoard(cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: columnIds.map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: cardsByColumn[columnId] ?? [],
		})),
		dependencies: [],
	};
}

/**
 * In-memory stand-in for the workspace state files. `getWorkspaceState` and
 * `mutateWorkspaceState` mirror the read-modify-write semantics of
 * src/state/workspace-state.ts, including the revision bump on save and the
 * ability to refuse a save (`save: false`).
 */
function createWorkspaceStateStore(initial: StoredWorkspaceState) {
	const stored = initial;

	const toResponse = (): RuntimeWorkspaceStateResponse =>
		({
			repoPath: "/repo",
			statePath: "/repo/.cline",
			git: { root: "/repo", currentBranch: "main", defaultBranch: "main" },
			board: structuredClone(stored.board),
			sessions: structuredClone(stored.sessions),
			revision: stored.revision,
		}) as unknown as RuntimeWorkspaceStateResponse;

	return {
		stored,
		getWorkspaceState: async (): Promise<RuntimeWorkspaceStateResponse> => toResponse(),
		mutateWorkspaceState: async <T>(
			_cwd: string,
			mutate: (state: RuntimeWorkspaceStateResponse) => {
				board: RuntimeBoardData;
				sessions?: Record<string, RuntimeTaskSessionSummary>;
				value: T;
				save?: boolean;
			},
		): Promise<{ value: T; state: RuntimeWorkspaceStateResponse; saved: boolean }> => {
			const current = toResponse();
			const result = mutate(current);
			if (result.save === false) {
				return { value: result.value, state: current, saved: false };
			}
			stored.board = result.board;
			if (result.sessions) {
				stored.sessions = result.sessions;
			}
			stored.revision += 1;
			return { value: result.value, state: toResponse(), saved: true };
		},
	};
}

function createFakeTerminalManager() {
	const unavailableTaskIds = new Set<string>();
	const sessionStates = new Map<string, { state: RuntimeTaskSessionState; updatedAt: number }>();
	const writeInput = vi.fn((taskId: string, _data: Buffer) => ({ taskId }) as unknown as RuntimeTaskSessionSummary);
	const getSummary = vi.fn((taskId: string) =>
		unavailableTaskIds.has(taskId)
			? null
			: ({ taskId, ...sessionStates.get(taskId) } as unknown as RuntimeTaskSessionSummary),
	);
	const stopTaskSession = vi.fn((_taskId: string) => null);
	const hasActiveSession = vi.fn((taskId: string) => !unavailableTaskIds.has(taskId));
	return {
		writeInput,
		getSummary,
		hasActiveSession,
		stopTaskSession,
		dropSession: (taskId: string) => {
			unavailableTaskIds.add(taskId);
		},
		setSessionState: (taskId: string, state: RuntimeTaskSessionState, updatedAt = Number.MAX_SAFE_INTEGER) => {
			sessionStates.set(taskId, { state, updatedAt });
		},
		manager: {
			writeInput,
			getSummary,
			hasActiveSession,
			stopTaskSession,
		} as unknown as TerminalSessionManager,
	};
}

function createFakeClineService() {
	const sendTaskSessionInput = vi.fn(async (taskId: string, _text: string, _mode?: string) => {
		await Promise.resolve();
		return { taskId } as unknown as RuntimeTaskSessionSummary;
	});
	const rebindPersistedTaskSession = vi.fn(async () => null);
	const getSummary = vi.fn((taskId: string) => ({ taskId }) as unknown as RuntimeTaskSessionSummary);
	return {
		sendTaskSessionInput,
		rebindPersistedTaskSession,
		getSummary,
		service: {
			sendTaskSessionInput,
			rebindPersistedTaskSession,
			getSummary,
		} as unknown as ClineTaskSessionService,
	};
}

interface HarnessOptions {
	board: RuntimeBoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	selectedAgentId?: RuntimeAgentId;
	clineService?: ClineTaskSessionService;
	promptTemplates?: TaskGitPromptTemplates;
	now?: () => number;
	checkConfig?: { command: string; timeoutMs: number; maxRetries: number } | null;
	doneCheckConfig?: { command: string; timeoutMs: number } | null;
	startTask?: (input: { workspacePath: string; taskId: string }) => Promise<unknown>;
}

function createHarness(options: HarnessOptions) {
	const store = createWorkspaceStateStore({
		board: options.board,
		sessions: options.sessions ?? {},
		revision: 1,
	});
	const probeResults = new Map<string, AutoReviewTaskProbe>();
	const probeTaskWorkspace = vi.fn(async ({ taskId }: { taskId: string }) => {
		await Promise.resolve();
		return probeResults.get(taskId) ?? { exists: false, headCommit: null, changedFiles: 0 };
	});
	const terminal = createFakeTerminalManager();
	const onBoardMutated = vi.fn();
	const deleteTaskWorktree = vi.fn(async () => ({ ok: true }));
	const warn = vi.fn();
	const startTask = vi.fn(options.startTask ?? (async () => undefined));
	const loadCheckConfig = vi.fn(async () => options.checkConfig ?? null);
	const runCheck = vi.fn(
		async (_input: { signal: AbortSignal }): Promise<AutoReviewCheckOutcome> => ({
			exitCode: 0,
			timedOut: false,
			output: "",
		}),
	);
	const loadDoneCheckConfig = vi.fn(async () => options.doneCheckConfig ?? null);
	const runDoneCheck = vi.fn(
		async (_input: RunAutoReviewCheckInput): Promise<AutoReviewCheckOutcome> => ({
			exitCode: 0,
			timedOut: false,
			output: "",
		}),
	);
	let staleSnapshot: RuntimeWorkspaceStateResponse | null = null;

	const dependencies: CreateAutoReviewReconcilerDependencies = {
		listWorkspaces: () => [
			{
				workspaceId: "ws-1",
				workspacePath: "/repo",
				terminalManager: terminal.manager,
			},
		],
		getWorkspaceState: async () => staleSnapshot ?? (await store.getWorkspaceState()),
		mutateWorkspaceState: store.mutateWorkspaceState,
		getPromptTemplates: async () =>
			options.promptTemplates ?? {
				commitPromptTemplate: "Commit the working changes onto {{base_ref}}.",
				openPrPromptTemplate: "Open a pull request against {{base_ref}}.",
				commitPromptTemplateDefault: null,
				openPrPromptTemplateDefault: null,
			},
		getSelectedAgentId: async () => options.selectedAgentId ?? null,
		getClineTaskSessionService: () => options.clineService ?? null,
		probeTaskWorkspace,
		deleteTaskWorktree,
		onBoardMutated,
		startTask,
		loadCheckConfig,
		runCheck,
		loadDoneCheckConfig,
		runDoneCheck,
		...(options.now ? { now: options.now } : {}),
		warn,
	};

	const reconciler = createAutoReviewReconciler(dependencies);

	return {
		reconciler,
		store,
		terminal,
		probeTaskWorkspace,
		deleteTaskWorktree,
		onBoardMutated,
		warn,
		startTask,
		loadCheckConfig,
		runCheck,
		loadDoneCheckConfig,
		runDoneCheck,
		/** Lets a detached project check finish and the follow-up evaluation it schedules run. */
		async settle() {
			for (let flush = 0; flush < 10; flush += 1) {
				await vi.advanceTimersByTimeAsync(0);
			}
		},
		setProbe(taskId: string, probe: AutoReviewTaskProbe) {
			probeResults.set(taskId, probe);
		},
		setStaleSnapshot(snapshot: RuntimeWorkspaceStateResponse | null) {
			staleSnapshot = snapshot;
		},
		async evaluate() {
			await reconciler.evaluateWorkspace("ws-1");
		},
	};
}

describe("auto-review reconciler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("advances a review card with no browser client connected", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		await harness.evaluate();

		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.columnId).toBe("review");
		expect(armed?.card.pendingGitAction).toEqual({
			action: "commit",
			requestedAt: expect.any(Number),
			headCommitAtRequest: "commit-1",
			hadUncommittedChanges: true,
			attempt: 0,
		});
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const [promptTaskId, promptData] = harness.terminal.writeInput.mock.calls[0];
		expect(promptTaskId).toBe("task-1");
		expect(promptData?.toString("utf8")).toBe("Commit the working changes onto main.");

		// The submit keystroke follows the prompt after the paste settles.
		await vi.advanceTimersByTimeAsync(250);
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(2);
		expect(harness.terminal.writeInput.mock.calls[1]?.[1]?.toString("utf8")).toBe("\r");

		// The commit lands on the base ref once the agent finishes: the card completes.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 0 });
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.onBoardMutated).toHaveBeenCalled();
	});

	it("lands commits the agent already made itself on a clean tree", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 1 });

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).toEqual({
			action: "commit",
			requestedAt: expect.any(Number),
			headCommitAtRequest: "commit-1",
			hadUncommittedChanges: false,
			attempt: 0,
		});
		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);

		// Still unlanded: the card stays armed.
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");

		// The cherry-pick lands on the base ref without moving the task HEAD: the card completes.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 0 });
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
		expect(harness.terminal.stopTaskSession).toHaveBeenCalledWith("task-1");
		expect(harness.deleteTaskWorktree).toHaveBeenCalledWith({ repoPath: "/repo", taskId: "task-1" });
	});

	it("drops the worktree of a Done card only once its work has landed on the base ref", async () => {
		let currentTime = 1_000_000;
		const card = createCard({ id: "task-1" });
		const harness = createHarness({ board: createBoard({ trash: [card] }), now: () => currentTime });

		// Unlanded commits: the worktree is the only checkout of that work.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 2 });
		await harness.evaluate();
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();

		// Uncommitted changes, and an unknown landing state, also keep it.
		currentTime += 61_000;
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3, unlandedCommits: 0 });
		await harness.evaluate();
		currentTime += 61_000;
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0 });
		await harness.evaluate();
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();

		// Landed and clean: removed. The card stays in Done.
		currentTime += 61_000;
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 0 });
		await harness.evaluate();
		expect(harness.deleteTaskWorktree).toHaveBeenCalledWith({ repoPath: "/repo", taskId: "task-1" });
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
	});

	it("probes Done worktrees at most once per sweep interval", async () => {
		let currentTime = 1_000_000;
		const card = createCard({ id: "task-1" });
		const harness = createHarness({ board: createBoard({ trash: [card] }), now: () => currentTime });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 1 });
		await harness.evaluate();
		await harness.evaluate();
		expect(harness.probeTaskWorkspace).toHaveBeenCalledTimes(1);
		currentTime += 61_000;
		await harness.evaluate();
		expect(harness.probeTaskWorkspace).toHaveBeenCalledTimes(2);
	});

	it("keeps the card in review until its commits have landed on the base ref", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 2, unlandedCommits: 0 });
		await harness.evaluate();

		// The agent committed (HEAD moved) but has not cherry-picked yet.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 1 });
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();

		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 0 });
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
		expect(harness.deleteTaskWorktree).toHaveBeenCalledTimes(1);
	});

	it("completes an armed card from persisted state after a runtime restart", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const harness = createHarness({ board: createBoard({ review: [armedCard] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 0 });

		// A fresh reconciler instance sees only the persisted arming state and
		// completes the action once nothing is left to land.
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
	});

	it("does not sweep interrupted tasks or worktrees on boot", async () => {
		const interruptedCards = [
			createCard({ id: "task-1" }),
			createCard({ id: "task-2" }),
			createCard({ id: "task-3" }),
		];
		const sessions: Record<string, RuntimeTaskSessionSummary> = {};
		for (const card of interruptedCards) {
			sessions[card.id] = { taskId: card.id, state: "interrupted" } as unknown as RuntimeTaskSessionSummary;
		}
		const harness = createHarness({
			board: createBoard({ in_progress: interruptedCards }),
			sessions,
		});
		for (const card of interruptedCards) {
			harness.setProbe(card.id, { exists: true, headCommit: "commit-1", changedFiles: 2 });
		}

		await harness.evaluate();

		const boardAfter = harness.store.stored.board;
		for (const card of interruptedCards) {
			const found = findCardInBoard(boardAfter, card.id);
			expect(found?.columnId).toBe("in_progress");
		}
		expect(harness.store.stored.sessions).toEqual(sessions);
		// Three interrupted tasks in, three worktrees out: nothing was probed,
		// stopped, restarted, trashed, or cleaned up.
		expect(harness.probeTaskWorkspace).not.toHaveBeenCalled();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		expect(harness.store.stored.revision).toBe(1);
	});

	it("performs zero git probes for a workspace with no auto-review candidates", async () => {
		const harness = createHarness({
			board: createBoard({
				backlog: [createCard({ id: "task-backlog" })],
				in_progress: [createCard({ id: "task-running" })],
				// Enabled=false and missing auto-review config are both non-candidates.
				review: [
					createCard({ id: "task-review-disabled", autoReviewEnabled: false }),
					createCard({ id: "task-review-default" }),
				],
			}),
		});
		harness.setProbe("task-running", { exists: true, headCommit: "commit-1", changedFiles: 4 });
		harness.setProbe("task-review-default", { exists: true, headCommit: "commit-1", changedFiles: 4 });

		await harness.evaluate();

		expect(harness.probeTaskWorkspace).not.toHaveBeenCalled();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		expect(harness.store.stored.revision).toBe(1);
	});

	it("starts exactly one git action when two evaluations race", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		// Both evaluations observed the unarmed board before either persisted the
		// arming state. The compare-and-set mutation must let only one through.
		const staleSnapshot = await harness.store.getWorkspaceState();
		harness.setStaleSnapshot(staleSnapshot);

		await Promise.all([harness.reconciler.evaluateWorkspace("ws-1"), harness.reconciler.evaluateWorkspace("ws-1")]);

		expect(harness.terminal.writeInput).toHaveBeenCalledTimes(1);
		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.card.pendingGitAction).not.toBeNull();
		expect(armed?.card.pendingGitAction?.attempt).toBe(0);
	});

	it("delivers git actions through the native Cline session service", async () => {
		const cline = createFakeClineService();
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({
			board: createBoard({ review: [card] }),
			selectedAgentId: "cline",
			clineService: cline.service,
		});
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		await harness.evaluate();

		const armed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(armed?.card.pendingGitAction).not.toBeNull();
		expect(cline.sendTaskSessionInput).toHaveBeenCalledTimes(1);
		expect(cline.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "Commit the working changes onto main.", "act");
		// The terminal path must not be used for native Cline sessions.
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();

		// Completion still works once the work lands.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 0 });
		await harness.evaluate();

		const completed = findCardInBoard(harness.store.stored.board, "task-1");
		expect(completed?.columnId).toBe("trash");
		expect(completed?.card.pendingGitAction ?? null).toBeNull();
	});

	it("never arms a native Cline card while no Cline session exists", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({
			board: createBoard({ review: [card] }),
			selectedAgentId: "cline",
			// No Cline service exists for the workspace yet.
		});
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 3 });

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(harness.store.stored.revision).toBe(1);

		// The skip is logged once per task, not once per cycle.
		await harness.evaluate();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
	});

	it("clears a pending git action once it goes stale", async () => {
		let currentTime = 1_000_000;
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: 0,
				headCommitAtRequest: "commit-1",
				attempt: 2,
			},
		});
		const harness = createHarness({
			board: createBoard({ review: [armedCard] }),
			now: () => currentTime,
		});
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0 });

		// Just inside the staleness window the card stays armed.
		currentTime = 14 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();

		// Past the window the stale arming state is cleared so the card can re-arm.
		currentTime = 16 * 60_000;
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		expect(harness.terminal.writeInput).not.toHaveBeenCalled();
	});

	it("keeps the worktree when the landing state is unknown", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const harness = createHarness({ board: createBoard({ review: [armedCard] }) });
		// `git cherry` failed, so the probe has no landing evidence to offer.
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: undefined });

		await harness.evaluate();

		// Nothing proves the work landed: the card stays armed and the worktree survives.
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).not.toBeNull();
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	it("does not delete the worktree when HEAD moved but landing could not be verified", async () => {
		const armedCard = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: {
				action: "commit",
				requestedAt: Date.now(),
				headCommitAtRequest: "commit-1",
				attempt: 0,
			},
		});
		const harness = createHarness({ board: createBoard({ review: [armedCard] }) });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: undefined });

		await harness.evaluate();

		// A moved HEAD proves nothing about the base ref, and Done must mean landed.
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	const armedAt = (overrides: Record<string, unknown> = {}) => ({
		action: "commit" as const,
		requestedAt: Date.now(),
		headCommitAtRequest: "commit-1",
		attempt: 0,
		...overrides,
	});
	const landedProbe = { exists: true, headCommit: "commit-2", changedFiles: 0, unlandedCommits: 0 };

	it("keeps a card armed through its commit turn in progress, then completes it", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true, pendingGitAction: armedAt() });
		const harness = createHarness({ board: createBoard({ in_progress: [card] }) });
		harness.setProbe("task-1", landedProbe);
		harness.terminal.setSessionState("task-1", "running");

		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("in_progress");
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction).not.toBeNull();

		harness.terminal.setSessionState("task-1", "awaiting_review");
		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");

		await harness.evaluate();
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
	});

	it("still disarms a card that left the commit flow", async () => {
		const backlogCard = createCard({ id: "task-1", autoReviewEnabled: true, pendingGitAction: armedAt() });
		const toggledOff = createCard({ id: "task-2", autoReviewEnabled: false, pendingGitAction: armedAt() });
		const harness = createHarness({ board: createBoard({ backlog: [backlogCard], in_progress: [toggledOff] }) });

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.card.pendingGitAction ?? null).toBeNull();
		expect(findCardInBoard(harness.store.stored.board, "task-2")?.card.pendingGitAction ?? null).toBeNull();
	});

	it("moves any finished in-progress card to review with no browser connected", async () => {
		const card = createCard({ id: "task-1", updatedAt: 100 });
		const harness = createHarness({ board: createBoard({ in_progress: [card] }) });
		harness.terminal.setSessionState("task-1", "awaiting_review", 200);

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
	});

	it.each(["failed", "interrupted"] as const)("leaves a %s session's half-done work in progress", async (state) => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true, updatedAt: 100 });
		const harness = createHarness({ board: createBoard({ in_progress: [card] }) });
		harness.terminal.setSessionState("task-1", state, 200);

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("in_progress");
	});

	it("does not bounce a card dragged back after its session finished", async () => {
		const card = createCard({ id: "task-1", updatedAt: 300 });
		const harness = createHarness({ board: createBoard({ in_progress: [card] }) });
		harness.terminal.setSessionState("task-1", "awaiting_review", 200);

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("in_progress");
	});

	it("does not judge an armed card while its agent is still running", async () => {
		const card = createCard({ id: "task-1", autoReviewEnabled: true, pendingGitAction: armedAt() });
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", landedProbe);
		harness.terminal.setSessionState("task-1", "running");

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		expect(harness.probeTaskWorkspace).not.toHaveBeenCalled();
	});

	it("does not count discarded changes as a landing", async () => {
		const card = createCard({
			id: "task-1",
			autoReviewEnabled: true,
			pendingGitAction: armedAt({ hadUncommittedChanges: true }),
		});
		const harness = createHarness({ board: createBoard({ review: [card] }) });
		harness.setProbe("task-1", { ...landedProbe, headCommit: "commit-1" });

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();
	});

	const boardWithDependent = () => {
		const board = createBoard({
			backlog: [createCard({ id: "waiter" })],
			review: [createCard({ id: "task-1", autoReviewEnabled: true, pendingGitAction: armedAt() })],
		});
		board.dependencies = [{ id: "dep-1", fromTaskId: "waiter", toTaskId: "task-1", createdAt: 0 }];
		return board;
	};

	it("starts dependents once a card lands, with no client involved", async () => {
		const harness = createHarness({ board: boardWithDependent() });
		harness.setProbe("task-1", landedProbe);

		await harness.evaluate();

		expect(harness.startTask).toHaveBeenCalledTimes(1);
		expect(harness.startTask).toHaveBeenCalledWith({ workspacePath: "/repo", taskId: "waiter" });
	});

	it("does not start dependents when the card has not landed", async () => {
		const harness = createHarness({ board: boardWithDependent() });
		harness.setProbe("task-1", { ...landedProbe, unlandedCommits: 1 });

		await harness.evaluate();

		expect(harness.startTask).not.toHaveBeenCalled();
	});

	it("keeps the landed card done when a dependent fails to start", async () => {
		const harness = createHarness({
			board: boardWithDependent(),
			startTask: async () => {
				throw new Error("no agent");
			},
		});
		harness.setProbe("task-1", landedProbe);

		await harness.evaluate();

		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("trash");
		expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('"waiter"'));
	});

	describe("project check", () => {
		const checkConfig = { command: "make test", timeoutMs: 60_000, maxRetries: 1 };
		const dirtyProbe = {
			exists: true,
			headCommit: "commit-1",
			changedFiles: 2,
			unlandedCommits: 0,
			stateToken: "s1",
		};
		const failure = { exitCode: 1, timedOut: false, output: "boom" };
		const createCheckHarness = (config: typeof checkConfig | null = checkConfig) => {
			const card = createCard({ id: "task-1", autoReviewEnabled: true });
			const harness = createHarness({ board: createBoard({ review: [card] }), checkConfig: config });
			harness.setProbe("task-1", dirtyProbe);
			return harness;
		};
		const storedCard = (harness: ReturnType<typeof createHarness>) =>
			findCardInBoard(harness.store.stored.board, "task-1")?.card;
		const sentPrompts = (harness: ReturnType<typeof createHarness>) =>
			harness.terminal.writeInput.mock.calls
				.map(([, data]) => data.toString("utf8"))
				.filter((text) => text !== "\r");

		it("arms straight away when the project has no check", async () => {
			const harness = createCheckHarness(null);

			await harness.evaluate();

			expect(harness.runCheck).not.toHaveBeenCalled();
			expect(storedCard(harness)?.pendingGitAction).toBeTruthy();
			expect(storedCard(harness)?.checkResult).toBeUndefined();
		});

		it("commits only after the check passes", async () => {
			const harness = createCheckHarness();
			let finish: (outcome: AutoReviewCheckOutcome) => void = () => undefined;
			harness.runCheck.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);

			await harness.evaluate();
			await harness.settle();
			expect(storedCard(harness)?.checkResult?.status).toBe("running");
			expect(storedCard(harness)?.pendingGitAction ?? null).toBeNull();
			expect(harness.terminal.writeInput).not.toHaveBeenCalled();

			// A cycle during the run neither blocks on it nor starts a second one.
			await harness.evaluate();
			expect(harness.runCheck).toHaveBeenCalledTimes(1);

			finish({ exitCode: 0, timedOut: false, output: "ok" });
			await harness.settle();

			expect(storedCard(harness)?.checkResult).toMatchObject({ status: "passed", exitCode: 0, fingerprint: "s1" });
			expect(storedCard(harness)?.pendingGitAction).toBeTruthy();
			expect(sentPrompts(harness)).toEqual(["Commit the working changes onto main."]);
			expect(harness.runCheck).toHaveBeenCalledTimes(1);
		});

		it("sends one failure back to the agent, then waits for the user", async () => {
			const harness = createCheckHarness();
			harness.runCheck.mockResolvedValue(failure);

			await harness.evaluate();
			await harness.settle();

			expect(storedCard(harness)?.checkResult).toMatchObject({ status: "failed", retries: 1 });
			expect(storedCard(harness)?.pendingGitAction ?? null).toBeNull();
			expect(sentPrompts(harness)).toHaveLength(1);
			expect(sentPrompts(harness)[0]).toContain("boom");
			expect(sentPrompts(harness)[0]).toContain("make test");

			// Nothing changed in the worktree: no second run and no second prompt.
			await harness.evaluate();
			await harness.settle();
			expect(harness.runCheck).toHaveBeenCalledTimes(1);

			// The agent's fix also fails: recorded, but no further tokens are spent.
			harness.setProbe("task-1", { ...dirtyProbe, stateToken: "s2" });
			await harness.evaluate();
			await harness.settle();
			expect(harness.runCheck).toHaveBeenCalledTimes(2);
			expect(storedCard(harness)?.checkResult).toMatchObject({ status: "failed", retries: 1, fingerprint: "s2" });
			expect(sentPrompts(harness)).toHaveLength(1);
			expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
		});

		it("commits after the retry fixes the failure", async () => {
			const harness = createCheckHarness();
			harness.runCheck.mockResolvedValueOnce(failure);

			await harness.evaluate();
			await harness.settle();
			harness.setProbe("task-1", { ...dirtyProbe, stateToken: "s2" });
			await harness.evaluate();
			await harness.settle();

			expect(storedCard(harness)?.checkResult).toMatchObject({ status: "passed", retries: 0 });
			expect(storedCard(harness)?.pendingGitAction).toBeTruthy();
		});

		it("does not check while the agent is still working", async () => {
			const harness = createCheckHarness();
			harness.terminal.setSessionState("task-1", "running");

			await harness.evaluate();
			await harness.settle();

			expect(harness.runCheck).not.toHaveBeenCalled();
			expect(storedCard(harness)?.pendingGitAction ?? null).toBeNull();
		});

		it("never prompts when retries are disabled", async () => {
			const harness = createCheckHarness({ ...checkConfig, maxRetries: 0 });
			harness.runCheck.mockResolvedValue(failure);

			await harness.evaluate();
			await harness.settle();

			expect(storedCard(harness)?.checkResult?.status).toBe("failed");
			expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		});

		it("holds cards and warns once when the check config is invalid", async () => {
			const harness = createCheckHarness();
			harness.loadCheckConfig.mockRejectedValue(new Error("bad json"));

			await harness.evaluate();
			await harness.evaluate();

			expect(harness.runCheck).not.toHaveBeenCalled();
			expect(storedCard(harness)?.pendingGitAction ?? null).toBeNull();
			expect(harness.warn).toHaveBeenCalledTimes(1);
		});

		it("reruns a check that a restart cut off", async () => {
			const card = createCard({
				id: "task-1",
				autoReviewEnabled: true,
				checkResult: {
					status: "running",
					command: "make test",
					exitCode: null,
					timedOut: false,
					output: "",
					fingerprint: null,
					retries: 0,
					startedAt: 1,
					finishedAt: null,
				},
			});
			const harness = createHarness({ board: createBoard({ review: [card] }), checkConfig });
			harness.setProbe("task-1", dirtyProbe);

			await harness.evaluate();
			await harness.settle();

			expect(harness.runCheck).toHaveBeenCalledTimes(1);
			expect(storedCard(harness)?.pendingGitAction).toBeTruthy();
		});

		it("aborts a running check on shutdown and records nothing further", async () => {
			const harness = createCheckHarness();
			let signal: AbortSignal | null = null;
			let finish: (outcome: AutoReviewCheckOutcome) => void = () => undefined;
			harness.runCheck.mockImplementationOnce((input) => {
				signal = input.signal;
				return new Promise((resolve) => {
					finish = resolve;
				});
			});

			await harness.evaluate();
			await harness.settle();
			harness.reconciler.close();
			expect((signal as AbortSignal | null)?.aborted).toBe(true);

			finish({ exitCode: 0, timedOut: false, output: "" });
			await harness.settle();
			expect(storedCard(harness)?.checkResult?.status).toBe("running");
			expect(harness.terminal.writeInput).not.toHaveBeenCalled();
		});
	});

	describe("done check", () => {
		const doneCheckConfig = { command: "sh check-notes.sh", timeoutMs: 60_000 };
		const failure = { exitCode: 1, timedOut: false, output: "STATUS: BLOCKED" };
		const createDoneHarness = (config: typeof doneCheckConfig | null = doneCheckConfig) => {
			const harness = createHarness({ board: boardWithDependent(), doneCheckConfig: config });
			harness.setProbe("task-1", landedProbe);
			return harness;
		};
		const location = (harness: ReturnType<typeof createHarness>) =>
			findCardInBoard(harness.store.stored.board, "task-1");

		it("lands as before when the project has no done check", async () => {
			const harness = createDoneHarness(null);

			await harness.evaluate();

			expect(harness.runDoneCheck).not.toHaveBeenCalled();
			expect(location(harness)?.columnId).toBe("trash");
			expect(location(harness)?.card.doneCheckResult).toBeUndefined();
			expect(harness.startTask).toHaveBeenCalledWith({ workspacePath: "/repo", taskId: "waiter" });
		});

		it("moves the card to done and starts dependents only after the done check passes", async () => {
			const harness = createDoneHarness();
			let finish: (outcome: AutoReviewCheckOutcome) => void = () => undefined;
			harness.runDoneCheck.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);

			await harness.evaluate();
			await harness.settle();
			expect(location(harness)?.columnId).toBe("review");
			expect(location(harness)?.card.doneCheckResult?.status).toBe("running");
			expect(harness.startTask).not.toHaveBeenCalled();
			expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();

			await harness.evaluate();
			expect(harness.runDoneCheck).toHaveBeenCalledTimes(1);

			finish({ exitCode: 0, timedOut: false, output: "ok" });
			await harness.settle();

			expect(location(harness)?.columnId).toBe("trash");
			expect(location(harness)?.card.doneCheckResult).toMatchObject({ status: "passed", fingerprint: "commit-2" });
			expect(harness.startTask).toHaveBeenCalledWith({ workspacePath: "/repo", taskId: "waiter" });
			expect(harness.deleteTaskWorktree).toHaveBeenCalledTimes(1);
		});

		it("tells the command which card it judges", async () => {
			const harness = createDoneHarness();

			await harness.evaluate();
			await harness.settle();

			expect(harness.runDoneCheck.mock.calls[0]?.[0]).toMatchObject({
				taskId: "task-1",
				command: "sh check-notes.sh",
				env: { KANBAN_TASK_ID: "task-1", KANBAN_TASK_TITLE: "Task task-1", KANBAN_BASE_REF: "main" },
			});
		});

		it("holds a failed card in review without prompting its agent or starting dependents", async () => {
			const harness = createDoneHarness();
			harness.runDoneCheck.mockResolvedValue(failure);

			await harness.evaluate();
			await harness.settle();
			await harness.evaluate();
			await harness.settle();

			expect(harness.runDoneCheck).toHaveBeenCalledTimes(1);
			expect(location(harness)?.columnId).toBe("review");
			expect(location(harness)?.card.doneCheckResult).toMatchObject({ status: "failed", exitCode: 1 });
			expect(harness.startTask).not.toHaveBeenCalled();
			expect(harness.deleteTaskWorktree).not.toHaveBeenCalled();
			expect(harness.terminal.writeInput).not.toHaveBeenCalled();
			expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("done check failed"));
		});

		it("re-runs the done check when a new commit lands", async () => {
			const harness = createDoneHarness();
			harness.runDoneCheck.mockResolvedValueOnce(failure);

			await harness.evaluate();
			await harness.settle();
			expect(location(harness)?.columnId).toBe("review");

			harness.setProbe("task-1", { ...landedProbe, headCommit: "commit-3" });
			await harness.evaluate();
			await harness.settle();

			expect(harness.runDoneCheck).toHaveBeenCalledTimes(2);
			expect(location(harness)?.columnId).toBe("trash");
			expect(harness.startTask).toHaveBeenCalledWith({ workspacePath: "/repo", taskId: "waiter" });
		});

		it("holds landed cards and warns once when the done check config is invalid", async () => {
			const harness = createDoneHarness();
			harness.loadDoneCheckConfig.mockRejectedValue(new Error("bad json"));

			await harness.evaluate();
			await harness.evaluate();

			expect(harness.runDoneCheck).not.toHaveBeenCalled();
			expect(location(harness)?.columnId).toBe("review");
			expect(harness.startTask).not.toHaveBeenCalled();
			expect(
				harness.warn.mock.calls.filter(([message]) => String(message).includes("done check config")),
			).toHaveLength(1);
		});

		it("aborts a running done check on shutdown and records nothing further", async () => {
			const harness = createDoneHarness();
			let signal: AbortSignal | null = null;
			let finish: (outcome: AutoReviewCheckOutcome) => void = () => undefined;
			harness.runDoneCheck.mockImplementationOnce((input) => {
				signal = input.signal;
				return new Promise((resolve) => {
					finish = resolve;
				});
			});

			await harness.evaluate();
			await harness.settle();
			harness.reconciler.close();
			expect((signal as AbortSignal | null)?.aborted).toBe(true);

			finish({ exitCode: 0, timedOut: false, output: "" });
			await harness.settle();
			expect(location(harness)?.columnId).toBe("review");
			expect(location(harness)?.card.doneCheckResult?.status).toBe("running");
			expect(harness.startTask).not.toHaveBeenCalled();
		});
	});

	it("stops re-prompting a card whose commits never land", async () => {
		let currentTime = 1_000_000;
		const card = createCard({ id: "task-1", autoReviewEnabled: true });
		const harness = createHarness({ board: createBoard({ review: [card] }), now: () => currentTime });
		harness.setProbe("task-1", { exists: true, headCommit: "commit-1", changedFiles: 0, unlandedCommits: 1 });

		// Each stale window re-arms and re-prompts; the cap ends the review <-> in_progress bounce.
		for (let cycle = 0; cycle < 6; cycle += 1) {
			await harness.evaluate();
			currentTime += 16 * 60_000;
			await harness.evaluate();
			currentTime += 1_000;
		}

		const promptCount = harness.terminal.writeInput.mock.calls.filter(
			([, data]) => data?.toString("utf8") !== "\r",
		).length;
		expect(promptCount).toBe(3);
		expect(findCardInBoard(harness.store.stored.board, "task-1")?.columnId).toBe("review");
	});
});

function findCardInBoard(
	board: RuntimeBoardData,
	taskId: string,
): { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}
