// Shared lifecycle for native-chat agent backends: summary/state machine, message store,
// persistence under the runtime home, cancel/stop/clear/rebind. A subclass supplies only the
// transport (how a user message reaches the agent and how its events become chat messages).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
	RuntimeAgentId,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { getRuntimeHomePath } from "../state/workspace-state";
import type { NativeChatBackend, StartNativeChatSessionRequest } from "./chat-backend";

export interface NativeChatSessionSettings {
	/** The agent's own conversation id (Claude session id, Codex thread id); null until it exists. */
	sessionId: string | null;
	cwd: string;
	mode: RuntimeTaskSessionMode | null;
	modelId: string | null;
	reasoningEffort: string | null;
	autonomousModeEnabled: boolean;
	systemPrompt: string | null;
	messages: ClineTaskMessage[];
}

export interface NativeChatSessionServiceOptions {
	stateDir?: string;
	messageRepository?: ClineMessageRepository;
}

interface NativeChatIdentity {
	agentId: RuntimeAgentId;
	/** Human name used in user-facing failure messages. */
	displayName: string;
	hookSource: string;
	/** Directory name under the runtime home where sessions are persisted. */
	stateDirName: string;
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message.trim() : "Unknown error";
}

export abstract class NativeChatSessionService implements NativeChatBackend {
	protected readonly repository: ClineMessageRepository;
	protected readonly settingsByTaskId = new Map<string, NativeChatSessionSettings>();
	protected slashCommands: ClineSdkSlashCommand[] = [];
	private readonly stateDir: string;

	protected constructor(
		private readonly identity: NativeChatIdentity,
		options: NativeChatSessionServiceOptions,
	) {
		this.repository = options.messageRepository ?? new InMemoryClineMessageRepository();
		this.stateDir = options.stateDir ?? join(getRuntimeHomePath(), identity.stateDirName);
	}

	/** Session id a fresh conversation starts with. */
	protected abstract createInitialSessionId(): string | null;
	/** Hands one user message to the agent, starting its transport if needed. Failures may throw. */
	protected abstract dispatch(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		canResume: boolean,
	): void;
	/** Ends the transport for a task without reporting a failure. */
	protected abstract terminate(taskId: string): void;
	/** Stops the running turn but keeps the conversation usable. */
	protected abstract interruptTurn(taskId: string): Promise<void>;
	protected abstract liveTaskIds(): string[];

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.repository.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		return this.repository.onMessage(listener);
	}

	async startTaskSession(request: StartNativeChatSessionRequest): Promise<RuntimeTaskSessionSummary> {
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
		const settings: NativeChatSessionSettings = {
			sessionId: persisted?.sessionId ?? this.createInitialSessionId(),
			cwd: request.cwd,
			mode: request.startInPlanMode ? "plan" : (request.mode ?? "act"),
			modelId: request.modelId?.trim() || null,
			reasoningEffort: request.reasoningEffort?.trim() || null,
			autonomousModeEnabled: request.autonomousModeEnabled === true,
			systemPrompt: request.systemPrompt?.trim() || null,
			messages: persisted?.messages ?? [],
		};
		this.settingsByTaskId.set(request.taskId, settings);

		const entry = this.createEntry(request.taskId, settings, {
			state: request.resumeFromTrash ? "awaiting_review" : hasPrompt ? "running" : "idle",
			reviewReason: request.resumeFromTrash ? "attention" : null,
		});
		this.repository.setTaskEntry(request.taskId, entry);
		this.emitSummary(entry.summary);

		if (hasPrompt) {
			this.deliver(request.taskId, entry, request.prompt, request.images, persisted !== null);
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
		this.deliver(taskId, entry, text, images, true);
		return cloneSummary(entry.summary);
	}

	private deliver(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		canResume: boolean,
	): void {
		const userMessage = createMessage(taskId, "user", text, images);
		entry.messages.push(userMessage);
		this.repository.emitMessage(taskId, userMessage);
		this.emitSummary(
			updateSummary(entry, { state: "running", reviewReason: null, lastOutputAt: now(), warningMessage: null }),
		);
		try {
			this.dispatch(taskId, entry, text, images, canResume);
		} catch (error) {
			this.reportFailure(taskId, entry, `could not start ${this.identity.displayName}: ${toErrorMessage(error)}`);
		}
	}

	protected emitMessages(taskId: string, entry: ClineTaskSessionEntry, messages: ClineTaskMessage[]): void {
		for (const message of messages) {
			this.repository.emitMessage(taskId, message);
		}
		if (messages.length > 0) {
			this.emitSummary(updateSummary(entry, { lastOutputAt: now() }));
		}
	}

	protected setSessionId(taskId: string, sessionId: string | null): void {
		const settings = this.settingsByTaskId.get(taskId);
		if (settings && sessionId && settings.sessionId !== sessionId) {
			settings.sessionId = sessionId;
			void this.persist(taskId);
		}
	}

	protected setModelId(entry: ClineTaskSessionEntry, modelId: string | null): void {
		if (modelId && entry.summary.modelId !== modelId) {
			this.emitSummary(updateSummary(entry, { modelId }));
		}
	}

	protected setSlashCommands(names: string[]): void {
		const unique = [...new Set(names)];
		if (unique.length > 0) {
			this.slashCommands = unique.map((name) => ({ name, instructions: `/${name}` }));
		}
	}

	protected completeTurn(
		taskId: string,
		entry: ClineTaskSessionEntry,
		isError: boolean,
		resultText: string | null,
	): void {
		if (isError) {
			const message = resultText?.trim() || `${this.identity.displayName} reported an error.`;
			const systemMessage = createMessage(taskId, "system", `${this.identity.displayName} failed: ${message}`);
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
					source: this.identity.hookSource,
				},
			}),
		);
		void this.persist(taskId);
	}

	protected reportFailure(taskId: string, entry: ClineTaskSessionEntry, message: string): void {
		const systemMessage = createMessage(
			taskId,
			"system",
			`${this.identity.displayName} failed: ${message}. You can send another message to continue the conversation.`,
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
					source: this.identity.hookSource,
				},
			}),
		);
		void this.persist(taskId);
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.repository.getTaskEntry(taskId);
		if (!entry || entry.summary.state !== "running") {
			return null;
		}
		await this.interruptTurn(taskId);
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
				source: this.identity.hookSource,
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
		// A fresh session id keeps the cleared conversation out of any later resume.
		const settings: NativeChatSessionSettings = {
			sessionId: this.createInitialSessionId(),
			cwd: existing.summary.workspacePath ?? previous?.cwd ?? ".",
			mode: existing.summary.mode ?? null,
			modelId: previous?.modelId ?? existing.summary.modelId,
			reasoningEffort: previous?.reasoningEffort ?? existing.summary.reasoningEffort,
			autonomousModeEnabled: previous?.autonomousModeEnabled ?? false,
			systemPrompt: previous?.systemPrompt ?? null,
			messages: [],
		};
		this.settingsByTaskId.set(taskId, settings);
		const cleared: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(taskId),
				agentId: this.identity.agentId,
				mode: existing.summary.mode,
				workspacePath: existing.summary.workspacePath,
			},
			messages: [],
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map(),
			toolInputByToolCallId: new Map(),
		};
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
		const entry = this.createEntry(taskId, persisted, { state: "awaiting_review", reviewReason: "attention" });
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
		if (this.repository.getTaskEntry(taskId)) {
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
		const taskIds = this.liveTaskIds();
		for (const taskId of taskIds) {
			this.terminate(taskId);
		}
		await Promise.all(taskIds.map((taskId) => this.persist(taskId)));
		this.repository.dispose();
	}

	protected emitSummary(summary: RuntimeTaskSessionSummary): void {
		this.repository.emitSummary(summary);
	}

	private createEntry(
		taskId: string,
		settings: NativeChatSessionSettings,
		state: Pick<RuntimeTaskSessionSummary, "state" | "reviewReason">,
	): ClineTaskSessionEntry {
		return {
			summary: {
				...createDefaultSummary(taskId),
				agentId: this.identity.agentId,
				state: state.state,
				reviewReason: state.reviewReason,
				mode: settings.mode,
				workspacePath: settings.cwd,
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
	}

	private async entryOrRebind(taskId: string): Promise<ClineTaskSessionEntry | null> {
		if (!this.repository.getTaskEntry(taskId) && !(await this.rebindPersistedTaskSession(taskId))) {
			return null;
		}
		return this.repository.getTaskEntry(taskId);
	}

	private emitAndReturn(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
		this.repository.emitSummary(summary);
		return summary;
	}

	private sessionFilePath(taskId: string): string {
		return join(this.stateDir, `${taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
	}

	/** Directory for transient files (for example image attachments) that belong to this backend. */
	protected get scratchDir(): string {
		return join(this.stateDir, "scratch");
	}

	protected async persist(taskId: string): Promise<void> {
		const entry = this.repository.getTaskEntry(taskId);
		const settings = this.settingsByTaskId.get(taskId);
		if (!entry || !settings) {
			return;
		}
		const payload: NativeChatSessionSettings = { ...settings, messages: entry.messages };
		const path = this.sessionFilePath(taskId);
		try {
			await mkdir(this.stateDir, { recursive: true });
			const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
			await writeFile(tmpPath, JSON.stringify(payload), { mode: 0o600 });
			await rename(tmpPath, path);
		} catch {
			// Best effort: the conversation also lives in the agent's own session store.
		}
	}

	private async readPersisted(taskId: string): Promise<NativeChatSessionSettings | null> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.sessionFilePath(taskId), "utf8"));
			if (typeof parsed !== "object" || parsed === null) {
				return null;
			}
			const record = parsed as Partial<NativeChatSessionSettings>;
			if (typeof record.cwd !== "string") {
				return null;
			}
			return {
				sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
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
