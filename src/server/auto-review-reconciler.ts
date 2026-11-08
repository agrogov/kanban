// Reconciles auto-review state inside the runtime instead of a browser tab.
//
// The browser implementation lived in a React effect and lost pending git
// actions on unmount, reload, or project switch. This module observes durable
// state (the board card's `pendingGitAction` field) and corrects the
// difference each cycle, so auto-review keeps running with no client
// connected and recovers armed cards after a restart.
//
// Git metadata is probed on demand: each cycle selects candidate cards from
// the board first, then probes only the worktrees of those candidates. A
// workspace with no auto-review candidates costs zero git work.

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import { type AutoReviewCheckConfig, loadAutoReviewCheckConfig } from "../config/auto-review-check-config";
import { isNativeChatAgentId } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskCheckResult,
	RuntimeTaskPendingGitAction,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	isPendingGitActionStale,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../core/task-board-mutations";
import type {
	RuntimeWorkspaceAtomicMutationResponse,
	RuntimeWorkspaceAtomicMutationResult,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { probeTaskLanding, type TaskLandingProbe } from "../workspace/task-landing-probe";
import { deleteTaskWorktree as deleteTaskWorktreeFromDisk } from "../workspace/task-worktree";
import {
	type AutoReviewCheckOutcome,
	buildCheckFailurePrompt,
	type RunAutoReviewCheckInput,
	runAutoReviewCheck,
} from "./auto-review-check";

/**
 * Evaluation cadence. Nothing here is latency critical: a slower interval
 * bounds the git-probe cost while still advancing cards promptly.
 */
const AUTO_REVIEW_EVALUATION_INTERVAL_MS = 5_000;

/**
 * How often Done cards are checked for a worktree whose work has landed. Each check is a git
 * probe per leftover worktree, so it runs far less often than the evaluation cycle.
 */
const DONE_WORKTREE_SWEEP_INTERVAL_MS = 60_000;

/**
 * Delay between pasting the git action prompt into the task terminal and
 * submitting it, matching the choreography the browser used.
 */
const AUTO_REVIEW_INPUT_SUBMIT_DELAY_MS = 200;

const AUTO_REVIEW_BASE_REF_TOKEN = "{{base_ref}}";

export interface TaskGitPromptTemplates {
	commitPromptTemplate?: string | null;
	openPrPromptTemplate?: string | null;
	commitPromptTemplateDefault?: string | null;
	openPrPromptTemplateDefault?: string | null;
}

export interface AutoReviewWorkspace {
	workspaceId: string;
	workspacePath: string | null;
	terminalManager: TerminalSessionManager | null;
}

export type AutoReviewTaskProbe = TaskLandingProbe;

export type MutateWorkspaceState = <T>(
	workspacePath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
) => Promise<RuntimeWorkspaceAtomicMutationResponse<T>>;

export interface CreateAutoReviewReconcilerDependencies {
	listWorkspaces: () => AutoReviewWorkspace[];
	getWorkspaceState: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	mutateWorkspaceState: MutateWorkspaceState;
	getPromptTemplates: (workspaceId: string, workspacePath: string) => Promise<TaskGitPromptTemplates | null>;
	/** Workspace-level default agent; cards may override it via `agentId`. */
	getSelectedAgentId?: (workspaceId: string, workspacePath: string) => Promise<RuntimeAgentId | null>;
	/** Native Cline session service for a workspace, when one exists. */
	getClineTaskSessionService?: (workspaceId: string) => ClineTaskSessionService | null;
	/** Probes one task worktree; injected in tests to count calls. */
	probeTaskWorkspace?: (input: {
		workspacePath: string;
		taskId: string;
		baseRef: string;
	}) => Promise<AutoReviewTaskProbe>;
	/**
	 * Notified after the reconciler mutates a board so connected browsers can
	 * resync. Optional: reconciliation is correct without it, browsers just
	 * observe the change later.
	 */
	onBoardMutated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	/** Removes a landed task's worktree; defaults to the real implementation. */
	deleteTaskWorktree?: (input: { repoPath: string; taskId: string }) => Promise<unknown>;
	/** Starts a backlog card whose prerequisites have all landed. Without it, dependents wait for a manual start. */
	startTask?: (input: { workspacePath: string; taskId: string }) => Promise<unknown>;
	/** Reads the project's check command; defaults to the project config file. */
	loadCheckConfig?: (workspacePath: string) => Promise<AutoReviewCheckConfig | null>;
	/** Runs the project's check command; defaults to the real implementation. */
	runCheck?: (input: RunAutoReviewCheckInput) => Promise<AutoReviewCheckOutcome>;
	evaluationIntervalMs?: number;
	now?: () => number;
	warn?: (message: string) => void;
}

export interface AutoReviewReconciler {
	/** Starts the evaluation cadence for every workspace managed by the runtime. */
	start: () => Promise<void>;
	/** Ensures a newly tracked workspace is picked up without waiting for the next cycle. */
	trackWorkspace: (workspaceId: string) => void;
	/** Stops tracking a workspace that was removed from the runtime. */
	untrackWorkspace: (workspaceId: string) => void;
	/** Runs one reconciliation cycle for a workspace. */
	evaluateWorkspace: (workspaceId: string) => Promise<void>;
	close: () => void;
}

interface ReconcilerWorkspaceRuntime {
	evaluationPromise: Promise<void> | null;
	pendingEvaluation: boolean;
	gitActionInFlightTaskIds: Set<string>;
	submitTimers: Set<NodeJS.Timeout>;
	clineUnavailableLoggedTaskIds: Set<string>;
	/** Git-action prompts sent per task for the current worktree HEAD, so a card that never lands is not re-prompted forever. */
	gitActionAttemptsByTaskId: Map<string, { headCommit: string | null; count: number }>;
	lastDoneWorktreeSweepAt: number;
	/** Project checks currently running, so a cycle never starts a second one for the same card. */
	checksInFlight: Map<string, AbortController>;
	/** Last reported problem with the check config, so a broken file warns once rather than every cycle. */
	checkConfigError: string | null;
}

/** Each attempt bounces the card review -> in_progress -> review, so stop after a few. */
const MAX_GIT_ACTION_ATTEMPTS_PER_HEAD = 3;

function createWorkspaceRuntime(): ReconcilerWorkspaceRuntime {
	return {
		evaluationPromise: null,
		pendingEvaluation: false,
		gitActionInFlightTaskIds: new Set<string>(),
		submitTimers: new Set<NodeJS.Timeout>(),
		clineUnavailableLoggedTaskIds: new Set<string>(),
		gitActionAttemptsByTaskId: new Map(),
		lastDoneWorktreeSweepAt: 0,
		checksInFlight: new Map(),
		checkConfigError: null,
	};
}

function abortRunningChecks(runtime: ReconcilerWorkspaceRuntime): void {
	for (const controller of runtime.checksInFlight.values()) {
		controller.abort();
	}
	runtime.checksInFlight.clear();
}

function resolveAutoReviewMode(card: RuntimeBoardCard): RuntimeTaskAutoReviewMode {
	return card.autoReviewMode === "pr" ? "pr" : "commit";
}

function resolvePromptTemplate(action: RuntimeTaskAutoReviewMode, templates: TaskGitPromptTemplates | null): string {
	if (action === "commit") {
		const template = templates?.commitPromptTemplate?.trim();
		if (template) {
			return template;
		}
		const defaultTemplate = templates?.commitPromptTemplateDefault?.trim();
		if (defaultTemplate) {
			return defaultTemplate;
		}
		return "Handle this commit action using the provided git context.";
	}
	const template = templates?.openPrPromptTemplate?.trim();
	if (template) {
		return template;
	}
	const defaultTemplate = templates?.openPrPromptTemplateDefault?.trim();
	if (defaultTemplate) {
		return defaultTemplate;
	}
	return "Handle this pull request action using the provided git context.";
}

function buildGitActionPrompt(
	action: RuntimeTaskAutoReviewMode,
	baseRef: string,
	templates: TaskGitPromptTemplates | null,
): string {
	return resolvePromptTemplate(action, templates).replaceAll(AUTO_REVIEW_BASE_REF_TOKEN, baseRef);
}

interface CardLocation {
	columnId: RuntimeBoardColumnId;
	card: RuntimeBoardCard;
}

function findCardLocation(board: RuntimeBoardData, taskId: string): CardLocation | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.id === taskId) {
				return { columnId: column.id, card };
			}
		}
	}
	return null;
}

function replaceBoardCard(board: RuntimeBoardData, taskId: string, nextCard: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => {
			if (!column.cards.some((card) => card.id === taskId)) {
				return column;
			}
			return {
				...column,
				cards: column.cards.map((card) => (card.id === taskId ? nextCard : card)),
			};
		}),
	};
}

export function createAutoReviewReconciler(deps: CreateAutoReviewReconcilerDependencies): AutoReviewReconciler {
	const workspaceRuntimes = new Map<string, ReconcilerWorkspaceRuntime>();
	const probeTaskWorkspace = deps.probeTaskWorkspace ?? probeTaskLanding;
	const loadCheckConfig = deps.loadCheckConfig ?? loadAutoReviewCheckConfig;
	const runCheck = deps.runCheck ?? runAutoReviewCheck;
	let disposed = false;
	let evaluationTimer: NodeJS.Timeout | null = null;

	const getOrCreateRuntime = (workspaceId: string): ReconcilerWorkspaceRuntime => {
		const existing = workspaceRuntimes.get(workspaceId);
		if (existing) {
			return existing;
		}
		const created = createWorkspaceRuntime();
		workspaceRuntimes.set(workspaceId, created);
		return created;
	};

	const armPendingGitAction = async (
		workspacePath: string,
		taskId: string,
		action: RuntimeTaskAutoReviewMode,
		headCommitAtRequest: string | null,
		hadUncommittedChanges: boolean,
		timestamp: number,
	): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || location.columnId !== "review" || location.card.autoReviewEnabled !== true) {
					return { board: currentState.board, value: "unavailable" as const, save: false };
				}
				const existing = location.card.pendingGitAction ?? null;
				if (existing && !isPendingGitActionStale(existing, timestamp)) {
					// Another actor already armed this card; the persisted field is the lock.
					return { board: currentState.board, value: "locked" as const, save: false };
				}
				const pendingGitAction: RuntimeTaskPendingGitAction = {
					action,
					requestedAt: timestamp,
					headCommitAtRequest,
					hadUncommittedChanges,
					attempt: existing ? existing.attempt + 1 : 0,
				};
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction,
						updatedAt: timestamp,
					}),
					value: "armed" as const,
				};
			});
			return response.value === "armed";
		} catch {
			return false;
		}
	};

	const clearPendingGitAction = async (workspacePath: string, taskId: string): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || (location.card.pendingGitAction ?? null) === null) {
					return { board: currentState.board, value: false, save: false };
				}
				return {
					board: replaceBoardCard(currentState.board, taskId, {
						...location.card,
						pendingGitAction: null,
						updatedAt: deps.now?.() ?? Date.now(),
					}),
					value: true,
				};
			});
			return response.value;
		} catch {
			return false;
		}
	};

	/** Moves a landed card to Done. Returns the dependents that became ready, or `null` if it did not move. */
	const completePendingGitAction = async (
		workspacePath: string,
		taskId: string,
		timestamp: number,
	): Promise<string[] | null> => {
		try {
			const response = await deps.mutateWorkspaceState<string[] | null>(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				if (!location || location.columnId !== "review") {
					return { board: currentState.board, value: null, save: false };
				}
				if (location.card.autoReviewEnabled !== true || !location.card.pendingGitAction) {
					return { board: currentState.board, value: null, save: false };
				}
				const moved = trashTaskAndGetReadyLinkedTaskIds(currentState.board, taskId, timestamp);
				if (!moved.moved || !moved.task) {
					return { board: currentState.board, value: null, save: false };
				}
				return {
					board: replaceBoardCard(moved.board, taskId, {
						...moved.task,
						pendingGitAction: null,
					}),
					value: moved.readyTaskIds,
				};
			});
			return response.value;
		} catch {
			return null;
		}
	};

	/** Mirrors the browser's move, so a card finishes its turn with no client connected. */
	const moveFinishedTaskToReview = async (
		workspacePath: string,
		taskId: string,
		sessionUpdatedAt: number,
		timestamp: number,
	): Promise<boolean> => {
		try {
			const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
				const location = findCardLocation(currentState.board, taskId);
				// A session older than the card's last change would bounce a card just dragged back by hand.
				if (!location || location.columnId !== "in_progress" || sessionUpdatedAt < location.card.updatedAt) {
					return { board: currentState.board, value: false, save: false };
				}
				const moved = moveTaskToColumn(currentState.board, taskId, "review", timestamp);
				if (!moved.moved) {
					return { board: currentState.board, value: false, save: false };
				}
				return { board: moved.board, value: true };
			});
			return response.value;
		} catch {
			return false;
		}
	};

	/** `state.sessions` comes from disk and goes stale with no browser connected, so ask the live sources. */
	const getFinishedSessionUpdatedAt = (workspace: AutoReviewWorkspace, taskId: string): number | null => {
		const summary =
			workspace.terminalManager?.getSummary(taskId) ??
			deps.getClineTaskSessionService?.(workspace.workspaceId)?.getSummary(taskId) ??
			null;
		return summary?.state === "awaiting_review" ? summary.updatedAt : null;
	};

	const isSessionRunning = (workspace: AutoReviewWorkspace, taskId: string): boolean => {
		const terminalManager = workspace.terminalManager;
		// `getSummary` also returns hydrated entries whose process is gone, so it needs the liveness check.
		if (terminalManager?.getSummary(taskId)?.state === "running" && terminalManager.hasActiveSession(taskId)) {
			return true;
		}
		return deps.getClineTaskSessionService?.(workspace.workspaceId)?.getSummary(taskId)?.state === "running";
	};

	const writeRunningCheckResult = async (
		workspacePath: string,
		taskId: string,
		checkResult: RuntimeTaskCheckResult,
	): Promise<void> => {
		await deps.mutateWorkspaceState(workspacePath, (currentState) => {
			const location = findCardLocation(currentState.board, taskId);
			if (!location) {
				return { board: currentState.board, value: undefined, save: false };
			}
			return {
				board: replaceBoardCard(currentState.board, taskId, { ...location.card, checkResult }),
				value: undefined,
			};
		});
	};

	/** Records a finished check. Returns whether the failure should go back to the task's agent. */
	const writeFinishedCheckResult = async (
		workspacePath: string,
		taskId: string,
		checkResult: RuntimeTaskCheckResult,
		maxRetries: number,
	): Promise<boolean> => {
		const response = await deps.mutateWorkspaceState(workspacePath, (currentState) => {
			const location = findCardLocation(currentState.board, taskId);
			if (!location) {
				return { board: currentState.board, value: false, save: false };
			}
			const retry =
				checkResult.status === "failed" &&
				location.columnId === "review" &&
				location.card.autoReviewEnabled === true &&
				checkResult.retries < maxRetries;
			return {
				board: replaceBoardCard(currentState.board, taskId, {
					...location.card,
					// A pass restores the budget: it limits consecutive failures, not a card's lifetime.
					checkResult: {
						...checkResult,
						retries: checkResult.status === "passed" ? 0 : checkResult.retries + (retry ? 1 : 0),
					},
				}),
				value: retry,
			};
		});
		return response.value;
	};

	const notifyBoardMutated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		try {
			await deps.onBoardMutated?.(workspaceId, workspacePath);
		} catch {
			// Broadcast is best-effort; the persisted board is already correct.
		}
	};

	// The task is merged into its base ref: stop its agent and drop the worktree (the UI's
	// trash workflow does the same when a card is trashed by hand). Best-effort; the card is
	// already in Done and the worktree can still be cleared manually.
	const cleanupLandedTask = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		taskId: string,
	): Promise<void> => {
		try {
			workspace.terminalManager?.stopTaskSession(taskId);
			await deps.getClineTaskSessionService?.(workspace.workspaceId)?.stopTaskSession(taskId);
			await (deps.deleteTaskWorktree ?? deleteTaskWorktreeFromDisk)({ repoPath: workspacePath, taskId });
		} catch (error) {
			deps.warn?.(`Auto-review could not clean up the worktree of task "${taskId}": ${String(error)}`);
		}
	};

	const startReadyTasks = async (workspacePath: string, taskIds: string[]): Promise<void> => {
		for (const taskId of taskIds) {
			try {
				await deps.startTask?.({ workspacePath, taskId });
			} catch (error) {
				deps.warn?.(`Auto-review could not start the ready task "${taskId}": ${String(error)}`);
			}
		}
	};

	// Cards reach Done without the trash workflow when their session is interrupted, which leaves
	// the worktree behind. Drop it once everything it holds has landed on the base ref; a worktree
	// with unlanded commits or uncommitted changes (or an unknown landing state) is kept.
	const sweepDoneWorktrees = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		state: RuntimeWorkspaceStateResponse,
		runtime: ReconcilerWorkspaceRuntime,
		timestamp: number,
	): Promise<void> => {
		if (timestamp - runtime.lastDoneWorktreeSweepAt < DONE_WORKTREE_SWEEP_INTERVAL_MS) {
			return;
		}
		runtime.lastDoneWorktreeSweepAt = timestamp;
		const doneColumn = state.board.columns.find((column) => column.id === "trash");
		for (const card of doneColumn?.cards ?? []) {
			if (!workspaceRuntimes.has(workspace.workspaceId)) {
				return;
			}
			const probe = await probeTaskWorkspace({
				workspacePath,
				taskId: card.id,
				baseRef: card.baseRef,
			}).catch(() => null);
			if (probe?.exists && probe.unlandedCommits === 0 && probe.changedFiles === 0) {
				await cleanupLandedTask(workspace, workspacePath, card.id);
			}
		}
	};

	const triggerTerminalGitAction = (
		terminalManager: TerminalSessionManager,
		card: RuntimeBoardCard,
		prompt: string,
		runtime: ReconcilerWorkspaceRuntime,
	): boolean => {
		let accepted: RuntimeTaskSessionSummary | null = null;
		try {
			accepted = terminalManager.writeInput(card.id, Buffer.from(prompt, "utf8"));
		} catch {
			accepted = null;
		}
		if (!accepted) {
			return false;
		}
		// Submit after the paste settles, mirroring the browser choreography.
		const submitTimer = setTimeout(() => {
			runtime.submitTimers.delete(submitTimer);
			try {
				terminalManager.writeInput(card.id, Buffer.from("\r", "utf8"));
			} catch {
				// The session died between prompt and submit; the failed trigger disarms.
			}
		}, AUTO_REVIEW_INPUT_SUBMIT_DELAY_MS);
		submitTimer.unref();
		runtime.submitTimers.add(submitTimer);
		return true;
	};

	const triggerClineGitAction = async (
		workspaceId: string,
		card: RuntimeBoardCard,
		prompt: string,
	): Promise<boolean> => {
		const service = deps.getClineTaskSessionService?.(workspaceId) ?? null;
		if (!service) {
			return false;
		}
		try {
			// Mirrors the chat-send route: retry once after rebinding a persisted
			// session whose SDK handle was lost (for example across a restart).
			let summary = await service.sendTaskSessionInput(card.id, prompt, "act");
			if (!summary) {
				const rebound = await service.rebindPersistedTaskSession(card.id);
				if (rebound) {
					summary = await service.sendTaskSessionInput(card.id, prompt, "act");
				}
			}
			return summary !== null;
		} catch {
			return false;
		}
	};

	const deliverPrompt = async (input: {
		workspace: AutoReviewWorkspace;
		card: RuntimeBoardCard;
		effectiveAgent: RuntimeAgentId | null;
		prompt: string;
		runtime: ReconcilerWorkspaceRuntime;
	}): Promise<boolean> => {
		if (isNativeChatAgentId(input.effectiveAgent)) {
			return await triggerClineGitAction(input.workspace.workspaceId, input.card, input.prompt);
		}
		if (!input.workspace.terminalManager) {
			return false;
		}
		return triggerTerminalGitAction(input.workspace.terminalManager, input.card, input.prompt, input.runtime);
	};

	const triggerGitAction = async (input: {
		workspace: AutoReviewWorkspace;
		card: RuntimeBoardCard;
		effectiveAgent: RuntimeAgentId | null;
		templates: TaskGitPromptTemplates | null;
		runtime: ReconcilerWorkspaceRuntime;
	}): Promise<boolean> => {
		const action = resolveAutoReviewMode(input.card);
		const prompt = buildGitActionPrompt(action, input.card.baseRef, input.templates);
		return await deliverPrompt({ ...input, prompt });
	};

	// Detached from the evaluation chain: a check can run for many minutes and must not hold up
	// every other card. Its result is stored on the card, and the next cycle acts on it.
	const runProjectCheck = async (input: {
		workspace: AutoReviewWorkspace;
		workspacePath: string;
		card: RuntimeBoardCard;
		effectiveAgent: RuntimeAgentId | null;
		config: AutoReviewCheckConfig;
		runtime: ReconcilerWorkspaceRuntime;
	}): Promise<void> => {
		const { workspace, workspacePath, card, config, runtime } = input;
		const controller = new AbortController();
		runtime.checksInFlight.set(card.id, controller);
		const startedAt = deps.now?.() ?? Date.now();
		const base = { command: config.command, retries: card.checkResult?.retries ?? 0, startedAt };
		let recorded = false;
		try {
			await writeRunningCheckResult(workspacePath, card.id, {
				...base,
				status: "running",
				exitCode: null,
				timedOut: false,
				output: "",
				fingerprint: null,
				finishedAt: null,
			});
			await notifyBoardMutated(workspace.workspaceId, workspacePath);
			const outcome = await runCheck({
				workspacePath,
				taskId: card.id,
				baseRef: card.baseRef,
				command: config.command,
				timeoutMs: config.timeoutMs,
				signal: controller.signal,
			});
			if (controller.signal.aborted) {
				return;
			}
			// Probed after the run, so a check that generates files does not invalidate its own result.
			const probe = await probeTaskWorkspace({
				workspacePath,
				taskId: card.id,
				baseRef: card.baseRef,
			}).catch(() => null);
			if (controller.signal.aborted) {
				return;
			}
			const retry = await writeFinishedCheckResult(
				workspacePath,
				card.id,
				{
					...base,
					status: outcome.exitCode === 0 && !outcome.timedOut ? "passed" : "failed",
					exitCode: outcome.exitCode,
					timedOut: outcome.timedOut,
					output: outcome.output,
					fingerprint: probe?.stateToken ?? null,
					finishedAt: deps.now?.() ?? Date.now(),
				},
				config.maxRetries,
			);
			recorded = true;
			await notifyBoardMutated(workspace.workspaceId, workspacePath);
			if (retry) {
				const prompt = buildCheckFailurePrompt(config.command, outcome);
				if (!(await deliverPrompt({ ...input, prompt }))) {
					deps.warn?.(`Auto-review could not send the failed check of task "${card.id}" back to its agent.`);
				}
			}
		} catch (error) {
			deps.warn?.(`Auto-review could not run the check of task "${card.id}": ${String(error)}`);
		} finally {
			runtime.checksInFlight.delete(card.id);
		}
		// Only after a recorded result: re-evaluating after a failed write would spin without any delay.
		if (recorded && !disposed && workspaceRuntimes.get(workspace.workspaceId) === runtime) {
			void evaluateWorkspace(workspace.workspaceId);
		}
	};

	const reconcileWorkspace = async (
		workspace: AutoReviewWorkspace,
		workspacePath: string,
		state: RuntimeWorkspaceStateResponse,
		runtime: ReconcilerWorkspaceRuntime,
	): Promise<void> => {
		const timestamp = deps.now?.() ?? Date.now();
		// Aborted mid-cycle when the workspace gets removed (project deletion or
		// shutdown); mutating a workspace that is being torn down could resurrect it.
		const stillTracked = (): boolean => workspaceRuntimes.has(workspace.workspaceId);
		let boardMutated = false;

		// Housekeeping pass first: finished in-progress cards go to review, and armed cards that left
		// the commit flow (or lost the auto-review toggle) are disarmed. This needs no git work.
		const candidates: RuntimeBoardCard[] = [];
		for (const column of state.board.columns) {
			for (const card of column.cards) {
				const pendingGitAction = card.pendingGitAction ?? null;
				if (column.id !== "review") {
					// Delivering the commit prompt sets the session running, which moves the card back to
					// in progress for that turn. It has to stay armed through that or the landing is missed.
					const armedForCommitTurn = column.id === "in_progress" && card.autoReviewEnabled === true;
					// A card that left review while armed must not stay armed forever.
					if (
						pendingGitAction &&
						!armedForCommitTurn &&
						stillTracked() &&
						(await clearPendingGitAction(workspacePath, card.id))
					) {
						boardMutated = true;
					}
					const finishedAt = column.id === "in_progress" ? getFinishedSessionUpdatedAt(workspace, card.id) : null;
					if (
						finishedAt !== null &&
						stillTracked() &&
						(await moveFinishedTaskToReview(workspacePath, card.id, finishedAt, timestamp))
					) {
						boardMutated = true;
					}
					continue;
				}
				if (card.autoReviewEnabled !== true) {
					if (pendingGitAction && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
					continue;
				}
				candidates.push(card);
			}
		}

		// No candidates: nothing to probe, nothing to arm or complete. This is the
		// common case and must cost zero git work.
		if (candidates.length > 0) {
			let selectedAgentId: RuntimeAgentId | null = null;
			try {
				selectedAgentId = (await deps.getSelectedAgentId?.(workspace.workspaceId, workspacePath)) ?? null;
			} catch {
				selectedAgentId = null;
			}
			let templates: TaskGitPromptTemplates | null = null;
			try {
				templates = await deps.getPromptTemplates(workspace.workspaceId, workspacePath);
			} catch {
				templates = null;
			}
			// One probe per card per cycle, even if both the armed and unarmed
			// branches look at the same card.
			const probeCache = new Map<string, Promise<AutoReviewTaskProbe>>();
			const probeTask = (card: RuntimeBoardCard): Promise<AutoReviewTaskProbe> => {
				const cached = probeCache.get(card.id);
				if (cached) {
					return cached;
				}
				const probe = probeTaskWorkspace({
					workspacePath,
					taskId: card.id,
					baseRef: card.baseRef,
				}).catch(() => ({ exists: false, headCommit: null, changedFiles: 0 }) satisfies AutoReviewTaskProbe);
				probeCache.set(card.id, probe);
				return probe;
			};

			// Read at most once per cycle, and only when a card actually reaches the check.
			let checkConfigPromise: Promise<AutoReviewCheckConfig | null | "invalid"> | null = null;
			const getCheckConfig = (): Promise<AutoReviewCheckConfig | null | "invalid"> => {
				checkConfigPromise ??= loadCheckConfig(workspacePath).then(
					(config) => {
						runtime.checkConfigError = null;
						return config;
					},
					(error: unknown) => {
						const message = String(error);
						if (runtime.checkConfigError !== message) {
							runtime.checkConfigError = message;
							deps.warn?.(`Auto-review is holding cards because the check config is invalid: ${message}`);
						}
						return "invalid" as const;
					},
				);
				return checkConfigPromise;
			};

			for (const card of candidates) {
				if (!stillTracked()) {
					break;
				}
				const pendingGitAction = card.pendingGitAction ?? null;
				const effectiveAgent = card.agentId ?? selectedAgentId;

				if (pendingGitAction) {
					// The agent may still be committing, and its worktree is not a stable thing to judge yet.
					if (isSessionRunning(workspace, card.id)) {
						continue;
					}
					// Done means landed, nothing else: no HEAD-moved fallback. Commits that exist only in the
					// worktree would be deleted with it. A tree that was dirty when armed also has to show a
					// new HEAD, otherwise an agent discarding its changes would look like a landing.
					const probe = await probeTask(card);
					const landed =
						probe.exists &&
						probe.unlandedCommits === 0 &&
						probe.changedFiles === 0 &&
						(pendingGitAction.hadUncommittedChanges !== true ||
							probe.headCommit !== pendingGitAction.headCommitAtRequest);
					if (landed) {
						const readyTaskIds = stillTracked()
							? await completePendingGitAction(workspacePath, card.id, timestamp)
							: null;
						if (readyTaskIds) {
							runtime.gitActionAttemptsByTaskId.delete(card.id);
							boardMutated = true;
							await cleanupLandedTask(workspace, workspacePath, card.id);
							await startReadyTasks(workspacePath, readyTaskIds);
						}
						continue;
					}
					if (isPendingGitActionStale(pendingGitAction, timestamp)) {
						if (await clearPendingGitAction(workspacePath, card.id)) {
							boardMutated = true;
						}
					}
					continue;
				}

				// Never arm a card whose delivery channel is missing: it could only
				// "complete" via the staleness timeout, which silently strands it.
				if (isNativeChatAgentId(effectiveAgent)) {
					const service = deps.getClineTaskSessionService?.(workspace.workspaceId) ?? null;
					const sessionSummary = service?.getSummary(card.id) ?? null;
					if (!service || !sessionSummary) {
						if (!runtime.clineUnavailableLoggedTaskIds.has(card.id)) {
							runtime.clineUnavailableLoggedTaskIds.add(card.id);
							deps.warn?.(
								`Auto-review is waiting for a native Cline session for task "${card.id}"; the card stays unarmed until one exists.`,
							);
						}
						continue;
					}
				} else if (!workspace.terminalManager || !workspace.terminalManager.hasActiveSession(card.id)) {
					// No live terminal session to deliver the prompt to. Arming and then
					// failing delivery would burn an attempt per cycle and eventually
					// give up on a card whose agent simply has not been started yet.
					continue;
				}

				const probe = await probeTask(card);
				// Review entries with nothing to land (common during planning loops)
				// are intentionally ignored.
				const hasWorkToLand = probe.changedFiles > 0 || (probe.unlandedCommits ?? 0) > 0;
				if (!probe.exists || !hasWorkToLand || runtime.gitActionInFlightTaskIds.has(card.id)) {
					continue;
				}

				const previousAttempts = runtime.gitActionAttemptsByTaskId.get(card.id);
				const attempts =
					previousAttempts && previousAttempts.headCommit === probe.headCommit
						? previousAttempts
						: { headCommit: probe.headCommit, count: 0 };
				if (attempts.count >= MAX_GIT_ACTION_ATTEMPTS_PER_HEAD) {
					if (attempts.count === MAX_GIT_ACTION_ATTEMPTS_PER_HEAD) {
						attempts.count += 1;
						runtime.gitActionAttemptsByTaskId.set(card.id, attempts);
						deps.warn?.(
							`Auto-review gave up on task "${card.id}" after ${MAX_GIT_ACTION_ATTEMPTS_PER_HEAD} attempts left work unlanded; land it manually.`,
						);
					}
					continue;
				}

				const checkConfig = await getCheckConfig();
				if (checkConfig === "invalid") {
					continue;
				}
				if (checkConfig) {
					if (runtime.checksInFlight.has(card.id) || isSessionRunning(workspace, card.id)) {
						continue;
					}
					const previous = card.checkResult ?? null;
					const previousIsCurrent =
						previous !== null &&
						previous.status !== "running" &&
						previous.fingerprint === (probe.stateToken ?? null);
					if (!previousIsCurrent) {
						// A persisted "running" with nothing in flight was cut off by a restart, so it reruns too.
						void runProjectCheck({
							workspace,
							workspacePath,
							card,
							effectiveAgent,
							config: checkConfig,
							runtime,
						});
						continue;
					}
					if (previous.status !== "passed") {
						continue;
					}
				}

				runtime.gitActionInFlightTaskIds.add(card.id);
				try {
					const armed = await armPendingGitAction(
						workspacePath,
						card.id,
						resolveAutoReviewMode(card),
						probe.headCommit,
						probe.changedFiles > 0,
						timestamp,
					);
					if (!armed || !stillTracked()) {
						continue;
					}
					boardMutated = true;
					attempts.count += 1;
					runtime.gitActionAttemptsByTaskId.set(card.id, attempts);
					const triggered = await triggerGitAction({ workspace, card, effectiveAgent, templates, runtime });
					if (!triggered && stillTracked() && (await clearPendingGitAction(workspacePath, card.id))) {
						boardMutated = true;
					}
				} finally {
					runtime.gitActionInFlightTaskIds.delete(card.id);
				}
			}
		}

		if (stillTracked()) {
			await sweepDoneWorktrees(workspace, workspacePath, state, runtime, timestamp);
		}

		if (boardMutated && stillTracked()) {
			await notifyBoardMutated(workspace.workspaceId, workspacePath);
		}
	};

	const evaluateWorkspaceOnce = async (workspaceId: string, runtime: ReconcilerWorkspaceRuntime): Promise<void> => {
		const workspace = deps.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId) ?? null;
		const workspacePath = workspace?.workspacePath ?? null;
		if (!workspace || !workspacePath) {
			workspaceRuntimes.delete(workspaceId);
			return;
		}

		let state: RuntimeWorkspaceStateResponse;
		try {
			state = await deps.getWorkspaceState(workspace.workspaceId, workspacePath);
		} catch (error) {
			deps.warn?.(`Auto-review could not read workspace state for ${workspace.workspaceId}: ${String(error)}`);
			return;
		}
		// The workspace may have been untracked while its state was being read.
		if (!workspaceRuntimes.has(workspaceId)) {
			return;
		}

		await reconcileWorkspace(workspace, workspacePath, state, runtime);
	};

	const evaluateWorkspace = async (workspaceId: string): Promise<void> => {
		if (disposed) {
			return;
		}
		const runtime = getOrCreateRuntime(workspaceId);
		// One evaluation chain per workspace. Late callers mark a pending cycle and
		// wait for the running chain, then run their own cycle, so every caller
		// observes a settled state.
		while (runtime.evaluationPromise) {
			runtime.pendingEvaluation = true;
			await runtime.evaluationPromise;
			if (disposed) {
				return;
			}
		}
		const chain = (async () => {
			do {
				runtime.pendingEvaluation = false;
				await evaluateWorkspaceOnce(workspaceId, runtime);
			} while (runtime.pendingEvaluation && !disposed);
		})()
			.catch((error) => {
				deps.warn?.(`Auto-review evaluation failed for ${workspaceId}: ${String(error)}`);
			})
			.finally(() => {
				runtime.evaluationPromise = null;
			});
		runtime.evaluationPromise = chain;
		await chain;
	};

	const evaluateAllWorkspaces = (): void => {
		for (const workspace of deps.listWorkspaces()) {
			if (workspace.workspacePath) {
				void evaluateWorkspace(workspace.workspaceId);
			}
		}
	};

	return {
		start: async () => {
			if (disposed) {
				return;
			}
			const intervalMs = deps.evaluationIntervalMs ?? AUTO_REVIEW_EVALUATION_INTERVAL_MS;
			if (!evaluationTimer) {
				evaluationTimer = setInterval(() => {
					if (!disposed) {
						evaluateAllWorkspaces();
					}
				}, intervalMs);
				evaluationTimer.unref();
			}
			evaluateAllWorkspaces();
		},
		trackWorkspace: (workspaceId: string) => {
			void evaluateWorkspace(workspaceId);
		},
		untrackWorkspace: (workspaceId: string) => {
			const runtime = workspaceRuntimes.get(workspaceId);
			if (runtime) {
				for (const timer of runtime.submitTimers) {
					clearTimeout(timer);
				}
				abortRunningChecks(runtime);
			}
			workspaceRuntimes.delete(workspaceId);
		},
		evaluateWorkspace,
		close: () => {
			disposed = true;
			if (evaluationTimer) {
				clearInterval(evaluationTimer);
				evaluationTimer = null;
			}
			for (const runtime of workspaceRuntimes.values()) {
				for (const timer of runtime.submitTimers) {
					clearTimeout(timer);
				}
				runtime.submitTimers.clear();
				abortRunningChecks(runtime);
				runtime.gitActionInFlightTaskIds.clear();
				runtime.clineUnavailableLoggedTaskIds.clear();
			}
			workspaceRuntimes.clear();
		},
	};
}
