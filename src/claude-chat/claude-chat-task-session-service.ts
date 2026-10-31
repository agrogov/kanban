// Native chat backend for Claude Code. Drives the Claude Agent SDK in streaming-input mode (one
// long-lived query per task) and maps its messages onto the same ClineTaskSessionService surface
// the chat UI, state hub and auto-review reconciler already consume for Cline.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Options, type Query, type SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { type ClineMessageRepository, InMemoryClineMessageRepository } from "../cline-sdk/cline-message-repository";
import {
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	cloneSummary,
	createDefaultSummary,
	createMessage,
	now,
	updateSummary,
} from "../cline-sdk/cline-session-state";
import { CLINE_BUILTIN_SLASH_COMMANDS } from "../cline-sdk/cline-slash-commands";
import type { ClineSdkSlashCommand } from "../cline-sdk/sdk-runtime-boundary";
import type {
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { getRuntimeHomePath } from "../state/workspace-state";
import { resolveBinaryOnPath } from "../terminal/command-discovery";
import { AsyncMessageQueue } from "./async-message-queue";
import {
	type ClaudeInitInfo,
	type ClaudeStreamReducerState,
	createClaudeStreamReducerState,
	reduceClaudeStreamEvent,
} from "./claude-stream-reducer";

export const CLAUDE_CHAT_AGENT_ID = "claude-chat";
const HOOK_SOURCE = "claude-chat";

export interface StartClaudeChatSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	autonomousModeEnabled?: boolean;
	resumeFromTrash?: boolean;
	resumeFromPersistence?: boolean;
	modelId?: string | null;
	reasoningEffort?: string | null;
	systemPrompt?: string | null;
	mode?: RuntimeTaskSessionMode;
}

export interface ClaudeChatTaskSessionService {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	startTaskSession(request: StartClaudeChatSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	listSlashCommands(): ClineSdkSlashCommand[];
	loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	hasTask(taskId: string): Promise<boolean>;
	dispose(): Promise<void>;
}

export type ClaudeChatQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface CreateClaudeChatTaskSessionServiceOptions {
	/** Path to a specific `claude` binary; defaults to `claude` on PATH, then the SDK's bundled one. */
	binary?: string | null;
	stateDir?: string;
	query?: ClaudeChatQuery;
	messageRepository?: ClineMessageRepository;
}

interface PersistedClaudeChatSession {
	sessionId: string;
	cwd: string;
	mode: RuntimeTaskSessionMode | null;
	modelId: string | null;
	reasoningEffort: string | null;
	autonomousModeEnabled: boolean;
	systemPrompt: string | null;
	messages: ClineTaskMessage[];
}

interface LiveSession {
	query: Query;
	input: AsyncMessageQueue<SDKUserMessage>;
	reducerState: ClaudeStreamReducerState;
	/** Set when Kanban ended the query on purpose, so the end of the stream is not reported as a crash. */
	terminatedByKanban: boolean;
	/** Set after interrupt(): the SDK answers with an error result that is not a real failure. */
	interruptPending: boolean;
}

interface LaunchSettings {
	cwd: string;
	sessionId: string;
	resume: boolean;
	modelId: string | null;
	reasoningEffort: string | null;
	autonomousModeEnabled: boolean;
	planMode: boolean;
	systemPrompt: string | null;
	binary: string | null;
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export function buildClaudeQueryOptions(settings: LaunchSettings): Options {
	const options: Options = {
		cwd: settings.cwd,
		includePartialMessages: true,
		// Same settings the interactive CLI loads, so the user's CLAUDE.md, skills and hooks apply.
		settingSources: ["user", "project", "local"],
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			...(settings.systemPrompt ? { append: settings.systemPrompt } : {}),
		},
	};
	if (settings.resume) {
		options.resume = settings.sessionId;
	} else {
		options.sessionId = settings.sessionId;
	}
	if (settings.planMode) {
		options.permissionMode = "plan";
	} else if (settings.autonomousModeEnabled) {
		options.permissionMode = "auto";
	}
	if (settings.modelId) {
		options.model = settings.modelId;
	}
	if (settings.reasoningEffort && EFFORT_LEVELS.has(settings.reasoningEffort)) {
		options.effort = settings.reasoningEffort as NonNullable<Options["effort"]>;
	}
	if (settings.binary) {
		options.pathToClaudeCodeExecutable = settings.binary;
	}
	return options;
}

type ClaudeUserContent = Exclude<SDKUserMessage["message"]["content"], string>;

export function buildClaudeUserMessage(text: string, images?: RuntimeTaskImage[]): SDKUserMessage {
	const imageBlocks: ClaudeUserContent = (images ?? []).map((image) => ({
		type: "image",
		source: {
			type: "base64",
			media_type: image.mimeType as "image/png",
			data: image.data,
		},
	}));
	return {
		type: "user",
		message: { role: "user", content: imageBlocks.length > 0 ? [...imageBlocks, { type: "text", text }] : text },
		parent_tool_use_id: null,
	};
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message.trim() : "Unknown error";
}

class ClaudeChatTaskSessionServiceImpl implements ClaudeChatTaskSessionService {
	private readonly repository: ClineMessageRepository;
	private readonly binary: string | null | undefined;
	private readonly stateDir: string;
	private readonly runQuery: ClaudeChatQuery;
	private readonly live = new Map<string, LiveSession>();
	private readonly settingsByTaskId = new Map<string, PersistedClaudeChatSession>();
	private slashCommands: ClineSdkSlashCommand[] = [];

	constructor(options: CreateClaudeChatTaskSessionServiceOptions) {
		this.repository = options.messageRepository ?? new InMemoryClineMessageRepository();
		this.binary = options.binary;
		this.stateDir = options.stateDir ?? join(getRuntimeHomePath(), "claude-chat");
		this.runQuery = options.query ?? sdkQuery;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.repository.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		return this.repository.onMessage(listener);
	}

	async startTaskSession(request: StartClaudeChatSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const existing = this.repository.getTaskEntry(request.taskId);
		const hasPrompt = request.prompt.trim().length > 0 || (request.images?.length ?? 0) > 0;
		if (
			!request.resumeFromTrash &&
			!request.resumeFromPersistence &&
			existing &&
			(existing.summary.state === "running" || existing.summary.state === "awaiting_review")
		) {
			return cloneSummary(existing.summary);
		}

		const persisted =
			request.resumeFromTrash || request.resumeFromPersistence ? await this.readPersisted(request.taskId) : null;
		const settings: PersistedClaudeChatSession = {
			sessionId: persisted?.sessionId ?? randomUUID(),
			cwd: request.cwd,
			mode: request.startInPlanMode ? "plan" : (request.mode ?? "act"),
			modelId: request.modelId?.trim() || null,
			reasoningEffort: request.reasoningEffort?.trim() || null,
			autonomousModeEnabled: request.autonomousModeEnabled === true,
			systemPrompt: request.systemPrompt?.trim() || null,
			messages: persisted?.messages ?? [],
		};
		this.settingsByTaskId.set(request.taskId, settings);

		const entry: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(request.taskId),
				agentId: CLAUDE_CHAT_AGENT_ID,
				state: request.resumeFromTrash ? "awaiting_review" : hasPrompt ? "running" : "idle",
				reviewReason: request.resumeFromTrash ? "attention" : null,
				mode: settings.mode,
				workspacePath: request.cwd,
				startedAt: now(),
				lastOutputAt: now(),
				modelId: settings.modelId,
				reasoningEffort: settings.reasoningEffort,
			},
			messages: settings.messages,
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map(),
			toolInputByToolCallId: new Map(),
		};
		this.repository.setTaskEntry(request.taskId, entry);
		this.emitSummary(entry.summary);

		if (hasPrompt) {
			await this.deliver(request.taskId, entry, request.prompt, request.images, persisted !== null);
		}
		return cloneSummary(entry.summary);
	}

	async sendTaskSessionInput(
		taskId: string,
		text: string,
		_mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.repository.getTaskEntry(taskId);
		if (!entry || !this.settingsByTaskId.has(taskId)) {
			return null;
		}
		await this.deliver(taskId, entry, text, images, true);
		return cloneSummary(entry.summary);
	}

	private async deliver(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		canResume: boolean,
	): Promise<void> {
		const userMessage = createMessage(taskId, "user", text, images);
		entry.messages.push(userMessage);
		this.repository.emitMessage(taskId, userMessage);
		this.emitSummary(
			updateSummary(entry, { state: "running", reviewReason: null, lastOutputAt: now(), warningMessage: null }),
		);
		try {
			const live = this.ensureSession(taskId, entry, canResume);
			live.input.push(buildClaudeUserMessage(text, images));
		} catch (error) {
			this.reportFailure(taskId, entry, `could not start Claude: ${toErrorMessage(error)}`);
		}
	}

	private ensureSession(taskId: string, entry: ClineTaskSessionEntry, canResume: boolean): LiveSession {
		const existing = this.live.get(taskId);
		if (existing) {
			return existing;
		}
		const settings = this.settingsByTaskId.get(taskId);
		if (!settings) {
			throw new Error(`No Claude chat settings for task ${taskId}.`);
		}
		const hasHistory = canResume && entry.messages.some((message) => message.role === "assistant");
		const input = new AsyncMessageQueue<SDKUserMessage>();
		const options = buildClaudeQueryOptions({
			cwd: settings.cwd,
			sessionId: settings.sessionId,
			resume: hasHistory,
			modelId: settings.modelId,
			reasoningEffort: settings.reasoningEffort,
			autonomousModeEnabled: settings.autonomousModeEnabled,
			planMode: settings.mode === "plan",
			systemPrompt: settings.systemPrompt,
			binary: this.binary === undefined ? resolveBinaryOnPath("claude") : this.binary,
		});
		let stderrTail = "";
		options.stderr = (data) => {
			stderrTail = `${stderrTail}${data}`.slice(-2000);
		};
		const live: LiveSession = {
			query: this.runQuery({ prompt: input, options }),
			input,
			reducerState: createClaudeStreamReducerState(),
			terminatedByKanban: false,
			interruptPending: false,
		};
		this.live.set(taskId, live);
		void this.pump(taskId, entry, live, () => stderrTail);
		return live;
	}

	private async pump(
		taskId: string,
		entry: ClineTaskSessionEntry,
		live: LiveSession,
		readStderr: () => string,
	): Promise<void> {
		let failure: string | null = null;
		try {
			for await (const message of live.query) {
				this.handleMessage(taskId, entry, live, message);
			}
		} catch (error) {
			failure = live.terminatedByKanban ? null : toErrorMessage(error);
		}
		if (this.live.get(taskId) === live) {
			this.live.delete(taskId);
		}
		live.input.close();
		this.emitSummary(updateSummary(entry, { pid: null }));
		if (!live.terminatedByKanban && entry.summary.state === "running") {
			this.reportFailure(taskId, entry, readStderr().trim() || failure || "Claude exited unexpectedly.");
		}
	}

	private handleMessage(taskId: string, entry: ClineTaskSessionEntry, live: LiveSession, event: unknown): void {
		const reduction = reduceClaudeStreamEvent(taskId, entry, live.reducerState, event);
		for (const message of reduction.changedMessages) {
			this.repository.emitMessage(taskId, message);
		}
		if (reduction.changedMessages.length > 0) {
			this.emitSummary(updateSummary(entry, { lastOutputAt: now() }));
		}
		if (reduction.init) {
			this.applyInit(taskId, entry, reduction.init);
		}
		if (reduction.turnResult) {
			if (live.interruptPending && reduction.turnResult.isError) {
				live.interruptPending = false;
				return;
			}
			live.interruptPending = false;
			this.completeTurn(taskId, entry, reduction.turnResult.isError, reduction.turnResult.text);
		}
	}

	private applyInit(taskId: string, entry: ClineTaskSessionEntry, init: ClaudeInitInfo): void {
		const settings = this.settingsByTaskId.get(taskId);
		if (settings && init.sessionId) {
			settings.sessionId = init.sessionId;
		}
		const names = [...new Set([...init.slashCommands, ...init.skills])];
		if (names.length > 0) {
			this.slashCommands = names.map((name) => ({ name, instructions: `/${name}` }));
		}
		if (init.model && entry.summary.modelId !== init.model) {
			this.emitSummary(updateSummary(entry, { modelId: init.model }));
		}
	}

	private completeTurn(
		taskId: string,
		entry: ClineTaskSessionEntry,
		isError: boolean,
		resultText: string | null,
	): void {
		if (isError) {
			const message = resultText?.trim() || "Claude reported an error.";
			const systemMessage = createMessage(taskId, "system", `Claude failed: ${message}`);
			entry.messages.push(systemMessage);
			this.repository.emitMessage(taskId, systemMessage);
		}
		this.emitSummary(
			updateSummary(entry, {
				state: "awaiting_review",
				reviewReason: isError ? "error" : "hook",
				lastOutputAt: now(),
				lastHookAt: now(),
				warningMessage: isError ? (resultText?.trim() ?? null) : null,
				latestHookActivity: {
					activityText: isError ? "Turn failed" : "Turn complete",
					toolName: null,
					toolInputSummary: null,
					finalMessage: resultText,
					hookEventName: isError ? "agent_error" : "Stop",
					notificationType: null,
					source: HOOK_SOURCE,
				},
			}),
		);
		void this.persist(taskId);
	}

	private reportFailure(taskId: string, entry: ClineTaskSessionEntry, message: string): void {
		const systemMessage = createMessage(
			taskId,
			"system",
			`Claude failed: ${message}. You can send another message to continue the conversation.`,
		);
		entry.messages.push(systemMessage);
		this.repository.emitMessage(taskId, systemMessage);
		this.emitSummary(
			updateSummary(entry, {
				state: "awaiting_review",
				reviewReason: "error",
				lastOutputAt: now(),
				lastHookAt: now(),
				warningMessage: message,
				latestHookActivity: {
					activityText: `Failed: ${message}`,
					toolName: null,
					toolInputSummary: null,
					finalMessage: message,
					hookEventName: "agent_error",
					notificationType: null,
					source: HOOK_SOURCE,
				},
			}),
		);
	}

	private terminate(taskId: string): void {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		live.terminatedByKanban = true;
		this.live.delete(taskId);
		live.input.close();
		live.query.close();
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.repository.getTaskEntry(taskId);
		if (!entry || entry.summary.state !== "running") {
			return null;
		}
		const live = this.live.get(taskId);
		if (live) {
			// interrupt() keeps the query (and its session) alive for the next message.
			live.interruptPending = true;
			try {
				await live.query.interrupt();
			} catch {
				live.interruptPending = false;
				this.terminate(taskId);
			}
		}
		entry.activeAssistantMessageId = null;
		entry.activeReasoningMessageId = null;
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			exitCode: null,
			pid: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: HOOK_SOURCE,
			},
		});
		this.emitSummary(summary);
		void this.persist(taskId);
		return summary;
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = await this.entryOrRebind(taskId);
		if (!entry) {
			return null;
		}
		this.terminate(taskId);
		await this.persist(taskId);
		if (entry.summary.state === "idle") {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			pid: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		return await this.stopTaskSession(taskId);
	}

	async reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = await this.entryOrRebind(taskId);
		if (!entry) {
			return null;
		}
		this.terminate(taskId);
		return this.emitAndReturn(
			updateSummary(entry, { state: "awaiting_review", reviewReason: "attention", pid: null }),
		);
	}

	async clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const existing = this.repository.getTaskEntry(taskId);
		const previous = this.settingsByTaskId.get(taskId);
		this.terminate(taskId);
		await rm(this.sessionFilePath(taskId), { force: true }).catch(() => undefined);
		this.repository.clearHydratedTaskMessages(taskId);
		if (!existing) {
			return null;
		}
		const cleared: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(taskId),
				agentId: CLAUDE_CHAT_AGENT_ID,
				mode: existing.summary.mode,
				workspacePath: existing.summary.workspacePath,
			},
			messages: [],
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map(),
			toolInputByToolCallId: new Map(),
		};
		// A fresh session id keeps the cleared conversation out of --resume.
		this.settingsByTaskId.set(taskId, {
			sessionId: randomUUID(),
			cwd: existing.summary.workspacePath ?? previous?.cwd ?? ".",
			mode: existing.summary.mode ?? null,
			modelId: previous?.modelId ?? existing.summary.modelId,
			reasoningEffort: previous?.reasoningEffort ?? existing.summary.reasoningEffort,
			autonomousModeEnabled: previous?.autonomousModeEnabled ?? false,
			systemPrompt: previous?.systemPrompt ?? null,
			messages: [],
		});
		this.repository.setTaskEntry(taskId, cleared);
		return this.emitAndReturn(cleared.summary);
	}

	async rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		if (this.repository.getTaskEntry(taskId)) {
			return this.repository.getSummary(taskId);
		}
		const persisted = await this.readPersisted(taskId);
		if (!persisted) {
			return null;
		}
		this.settingsByTaskId.set(taskId, persisted);
		const entry: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(taskId),
				agentId: CLAUDE_CHAT_AGENT_ID,
				state: "awaiting_review",
				reviewReason: "attention",
				mode: persisted.mode,
				workspacePath: persisted.cwd,
				startedAt: now(),
				lastOutputAt: now(),
				modelId: persisted.modelId,
				reasoningEffort: persisted.reasoningEffort,
			},
			messages: persisted.messages,
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map(),
			toolInputByToolCallId: new Map(),
		};
		this.repository.setTaskEntry(taskId, entry);
		return this.emitAndReturn(entry.summary);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.repository.getSummary(taskId);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return this.repository.listSummaries();
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		return this.repository.listMessages(taskId);
	}

	listSlashCommands(): ClineSdkSlashCommand[] {
		const builtins = CLINE_BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			instructions: `/${command.name}`,
			description: command.description,
		}));
		const reserved = new Set(builtins.map((command) => command.name));
		return [...builtins, ...this.slashCommands.filter((command) => !reserved.has(command.name))];
	}

	async loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]> {
		const live = this.repository.getTaskEntry(taskId);
		if (live) {
			return this.repository.listMessages(taskId);
		}
		return (await this.readPersisted(taskId))?.messages ?? [];
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const summary = this.repository.applyTurnCheckpoint(taskId, checkpoint);
		if (summary) {
			this.repository.emitSummary(summary);
		}
		return summary;
	}

	async hasTask(taskId: string): Promise<boolean> {
		if (this.repository.getTaskEntry(taskId)) {
			return true;
		}
		return (await this.readPersisted(taskId)) !== null;
	}

	async dispose(): Promise<void> {
		const taskIds = [...this.live.keys()];
		for (const taskId of taskIds) {
			this.terminate(taskId);
		}
		await Promise.all(taskIds.map((taskId) => this.persist(taskId)));
		this.repository.dispose();
	}

	private async entryOrRebind(taskId: string): Promise<ClineTaskSessionEntry | null> {
		if (!this.repository.getTaskEntry(taskId) && !(await this.rebindPersistedTaskSession(taskId))) {
			return null;
		}
		return this.repository.getTaskEntry(taskId);
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		this.repository.emitSummary(summary);
	}

	private emitAndReturn(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
		this.repository.emitSummary(summary);
		return summary;
	}

	private sessionFilePath(taskId: string): string {
		return join(this.stateDir, `${taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
	}

	private async persist(taskId: string): Promise<void> {
		const entry = this.repository.getTaskEntry(taskId);
		const settings = this.settingsByTaskId.get(taskId);
		if (!entry || !settings) {
			return;
		}
		const payload: PersistedClaudeChatSession = { ...settings, messages: entry.messages };
		const path = this.sessionFilePath(taskId);
		try {
			await mkdir(this.stateDir, { recursive: true });
			const tmpPath = `${path}.${process.pid}.tmp`;
			await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
			await rename(tmpPath, path);
		} catch {
			// Best effort: the conversation also lives in Claude's own session store.
		}
	}

	private async readPersisted(taskId: string): Promise<PersistedClaudeChatSession | null> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.sessionFilePath(taskId), "utf8"));
			if (typeof parsed !== "object" || parsed === null) {
				return null;
			}
			const record = parsed as Partial<PersistedClaudeChatSession>;
			if (typeof record.sessionId !== "string" || typeof record.cwd !== "string") {
				return null;
			}
			return {
				sessionId: record.sessionId,
				cwd: record.cwd,
				mode: record.mode ?? null,
				modelId: record.modelId ?? null,
				reasoningEffort: record.reasoningEffort ?? null,
				autonomousModeEnabled: record.autonomousModeEnabled === true,
				systemPrompt: record.systemPrompt ?? null,
				messages: Array.isArray(record.messages) ? record.messages : [],
			};
		} catch {
			return null;
		}
	}
}

export function createClaudeChatTaskSessionService(
	options: CreateClaudeChatTaskSessionServiceOptions = {},
): ClaudeChatTaskSessionService {
	return new ClaudeChatTaskSessionServiceImpl(options);
}
