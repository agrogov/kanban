// Native chat backend for Pi. Embeds the Pi coding agent SDK in-process (one AgentSession per
// task, persisted in a per-conversation session directory) and maps its events onto the same
// ClineTaskSessionService surface the chat UI already consumes for Cline, Claude and Codex.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, isModelType, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ClineMessageRepository } from "../cline-sdk/cline-message-repository";
import { type ClineTaskSessionEntry, updateSummary } from "../cline-sdk/cline-session-state";
import type { RuntimeTaskImage } from "../core/api-contract";
import { tokensPerSecond } from "../core/task-session-usage";
import type { NativeChatBackend } from "../native-chat/chat-backend";
import { NativeChatSessionService, toErrorMessage } from "../native-chat/native-chat-session-service";
import { getRuntimeHomePath } from "../state/workspace-state";
import { createPiReducerState, type PiReducerState, reducePiEvent } from "./pi-event-reducer";

export const PI_CHAT_AGENT_ID = "pi-chat";
const HOOK_SOURCE = "pi-chat";

export type PiChatTaskSessionService = NativeChatBackend;

/** The slice of AgentSession the service uses, so tests can inject a fake. */
export type PiChatSession = Pick<AgentSession, "prompt" | "abort" | "subscribe" | "dispose" | "messages">;

export type CreatePiChatSession = (options: PiSessionSettings) => Promise<PiChatSession>;

export interface CreatePiChatTaskSessionServiceOptions {
	stateDir?: string;
	createSession?: CreatePiChatSession;
	messageRepository?: ClineMessageRepository;
}

export interface PiSessionSettings {
	cwd: string;
	sessionDir: string;
	modelId: string | null;
	reasoningEffort: string | null;
	planMode: boolean;
}

interface PendingTurn {
	text: string;
	images: RuntimeTaskImage[] | undefined;
}

interface LiveSession {
	session: PiChatSession | null;
	unsubscribe: (() => void) | null;
	pending: PendingTurn[];
	running: boolean;
	/** Kanban canceled or ended the work on purpose, so the aborted run is not a failure. */
	stoppedByKanban: boolean;
	/**
	 * `terminate()` was called: the session must be released (subscription removed,
	 * agent session disposed, entry dropped) once the in-flight turn settles.
	 * Kept separate from `stoppedByKanban`, which runTurn clears for a mere cancel.
	 */
	terminating: boolean;
	reducerState: PiReducerState;
}

/**
 * Thinking levels Pi accepts, in the order the UI should offer them.
 *
 * Declared as a record over the SDK's own `ThinkingLevel` union so the compiler fails when
 * Pi adds, removes or renames a level. The UI reads this list through `getChatAgentModels`
 * instead of keeping its own copy, which is how the two used to drift apart.
 */
const PI_THINKING_LEVEL_FLAGS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} satisfies Record<ThinkingLevel, true>;

export const PI_CHAT_THINKING_LEVELS: readonly string[] = Object.keys(PI_THINKING_LEVEL_FLAGS);

const THINKING_LEVELS: ReadonlySet<string> = new Set(PI_CHAT_THINKING_LEVELS);
/** Plan mode: Pi has no permission modes, so restrict it to its read-only tools. */
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls"];

export function buildPiSessionOptions(
	settings: PiSessionSettings,
): Pick<CreateAgentSessionOptions, "cwd" | "tools" | "thinkingLevel"> {
	const options: Pick<CreateAgentSessionOptions, "cwd" | "tools" | "thinkingLevel"> = { cwd: settings.cwd };
	if (settings.planMode) {
		options.tools = PLAN_MODE_TOOLS;
	}
	if (settings.reasoningEffort && THINKING_LEVELS.has(settings.reasoningEffort)) {
		options.thinkingLevel = settings.reasoningEffort as ThinkingLevel;
	}
	return options;
}

/**
 * Resolve the Pi model for a chat session, or explain why there is none.
 *
 * With no model id the Pi SDK falls back to its own default, which silently
 * issues a provider request even when Pi has no credentials at all — that
 * request only surfaces as an opaque "Request timed out." minutes later. Check
 * availability up front so the chat reports the real problem immediately.
 */
export function selectPiChatModel<T extends { provider: string; id: string }>(
	configuredModels: readonly T[],
	allModels: readonly T[],
	modelId: string | null,
	fallbackModelId: string | null = null,
): T | null {
	if (allModels.length === 0) {
		throw new Error(
			"Pi has no models configured. Add a provider to ~/.pi/agent/models.json (or run the `pi` CLI once) and retry.",
		);
	}
	// Same convention as `pi --model`: "provider/id" or a bare model id. Bare ids resolve
	// against the availability snapshot first (configured providers, custom `models.json`
	// providers included, credentialless built-ins excluded): the full catalog also holds
	// built-ins the user never signed into, so `openrouter/auto` would otherwise beat the
	// user's own `ali-cloud-auto/auto` and fail mid-turn on missing OpenRouter credentials.
	// Qualified `provider/id` requests still fall through to the catalog, so an explicit
	// choice reports the SDK's own auth guidance instead of "not available".
	const matches = (candidate: T, candidateId: string): boolean =>
		`${candidate.provider}/${candidate.id}` === candidateId || candidate.id === candidateId;
	const findModel = (candidateId: string): T | undefined =>
		configuredModels.find((candidate) => matches(candidate, candidateId)) ??
		allModels.find((candidate) => matches(candidate, candidateId));
	if (!modelId) {
		// No model was requested: honour pi's own default (settings.json) instead of
		// leaving it to the SDK, which would pick an unrelated built-in model.
		return fallbackModelId ? (findModel(fallbackModelId) ?? null) : null;
	}
	const model = findModel(modelId);
	if (!model) {
		throw new Error(`Pi model "${modelId}" is not available. Check your Pi configuration.`);
	}
	return model;
}

/**
 * The default model the `pi` CLI itself would pick, from its settings file
 * (`defaultProvider` / `defaultModel`). Kanban must apply it explicitly: creating
 * a session without a model lets the SDK fall back to a built-in model, which is
 * not what the user configured.
 */
export async function readPiDefaultModel(agentDir: string = getAgentDir()): Promise<string | null> {
	try {
		const raw = await readFile(join(agentDir, "settings.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			return null;
		}
		// The CLI treats the user's enabled model list as the scoped selection, which
		// wins over `defaultProvider`/`defaultModel`; using the latter alone picked a
		// provider the user is not actually driving.
		const enabledModels = (parsed as { enabledModels?: unknown }).enabledModels;
		if (Array.isArray(enabledModels)) {
			const firstEnabled = enabledModels.find(
				(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
			);
			if (firstEnabled) {
				return firstEnabled.trim();
			}
		}
		const provider = (parsed as { defaultProvider?: unknown }).defaultProvider;
		const model = (parsed as { defaultModel?: unknown }).defaultModel;
		if (typeof provider !== "string" || typeof model !== "string" || !provider.trim() || !model.trim()) {
			return null;
		}
		return `${provider.trim()}/${model.trim()}`;
	} catch {
		return null;
	}
}

const createSdkSession: CreatePiChatSession = async (settings) => {
	const options: CreateAgentSessionOptions = {
		...buildPiSessionOptions(settings),
		// continueRecent resumes the conversation stored in the per-conversation directory, if any.
		sessionManager: SessionManager.continueRecent(settings.cwd, settings.sessionDir),
	};
	const modelRuntime = await ModelRuntime.create();
	// Only chat models can be handed to the session (`getAllModels()` also lists
	// image/classifier entries). The availability snapshot keeps exactly the models
	// whose providers are configured; the full catalog stays as the fallback pool for
	// explicitly qualified requests.
	const chatModels: Model<Api>[] = modelRuntime
		.getAllModels()
		.filter((candidate): candidate is Model<Api> => isModelType(candidate, "chat"));
	const configuredChatModels: Model<Api>[] = modelRuntime
		.getAvailableSnapshot()
		.filter((candidate): candidate is Model<Api> => isModelType(candidate, "chat"));
	const model = selectPiChatModel(configuredChatModels, chatModels, settings.modelId, await readPiDefaultModel());
	if (model) {
		options.modelRuntime = modelRuntime;
		options.model = model;
	}
	const { session } = await createAgentSession(options);
	return session;
};

class PiChatTaskSessionServiceImpl extends NativeChatSessionService {
	private readonly sessionsDir: string;
	private readonly createSession: CreatePiChatSession;
	private readonly live = new Map<string, LiveSession>();

	constructor(options: CreatePiChatTaskSessionServiceOptions) {
		super(
			{ agentId: PI_CHAT_AGENT_ID, displayName: "Pi", hookSource: HOOK_SOURCE, stateDirName: "pi-chat" },
			options,
		);
		this.sessionsDir = join(options.stateDir ?? join(getRuntimeHomePath(), "pi-chat"), "sessions");
		this.createSession = options.createSession ?? createSdkSession;
	}

	protected createInitialSessionId(): string {
		// Names the Pi session directory, so a cleared conversation never resumes the old one.
		return randomUUID();
	}

	protected liveTaskIds(): string[] {
		return [...this.live.keys()];
	}

	protected dispatch(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
	): void {
		let live = this.live.get(taskId);
		if (!live) {
			live = {
				session: null,
				unsubscribe: null,
				pending: [],
				running: false,
				stoppedByKanban: false,
				terminating: false,
				reducerState: createPiReducerState(),
			};
			this.live.set(taskId, live);
		}
		live.pending.push({ text, images });
		if (!live.running) {
			void this.drain(taskId, entry, live);
		}
	}

	private async openSession(taskId: string, entry: ClineTaskSessionEntry, live: LiveSession): Promise<PiChatSession> {
		const settings = this.settingsByTaskId.get(taskId);
		if (!settings?.sessionId) {
			throw new Error(`No Pi chat settings for task ${taskId}.`);
		}
		const session = await this.createSession({
			cwd: settings.cwd,
			sessionDir: join(this.sessionsDir, settings.sessionId),
			modelId: settings.modelId,
			reasoningEffort: settings.reasoningEffort,
			planMode: settings.mode === "plan",
		});
		live.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const reduction = reducePiEvent(taskId, entry, live.reducerState, event);
			this.emitMessages(taskId, entry, reduction.changedMessages);
			if (reduction.modelId) {
				this.setModelId(entry, reduction.modelId);
			}
			if (reduction.usageUpdate) {
				this.applyUsageUpdate(entry, reduction.usageUpdate);
			}
		});
		return session;
	}

	private async drain(taskId: string, entry: ClineTaskSessionEntry, live: LiveSession): Promise<void> {
		live.running = true;
		try {
			while (live.pending.length > 0 && !live.stoppedByKanban) {
				const turn = live.pending.shift();
				if (turn) {
					await this.runTurn(taskId, entry, live, turn);
				}
			}
		} finally {
			live.running = false;
			if (live.terminating) {
				this.release(taskId, live);
			}
		}
	}

	private async runTurn(
		taskId: string,
		entry: ClineTaskSessionEntry,
		live: LiveSession,
		turn: PendingTurn,
	): Promise<void> {
		const settings = this.settingsByTaskId.get(taskId);
		live.reducerState.lastError = null;
		live.reducerState.turnOutputTokens = 0;
		const turnStartedAt = Date.now();
		try {
			live.session ??= await this.openSession(taskId, entry, live);
			const isFirstTurn = live.session.messages.length === 0;
			const text = isFirstTurn && settings?.systemPrompt ? `${settings.systemPrompt}\n\n${turn.text}` : turn.text;
			await live.session.prompt(text, {
				images: turn.images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
			});
			if (!live.stoppedByKanban) {
				const error = live.reducerState.lastError;
				const rate = tokensPerSecond(live.reducerState.turnOutputTokens, Date.now() - turnStartedAt);
				this.completeTurn(
					taskId,
					entry,
					error !== null,
					error ?? live.reducerState.lastAssistantText,
					rate !== undefined ? { outputTokensPerSecond: rate } : undefined,
				);
			}
		} catch (error) {
			if (!live.stoppedByKanban) {
				this.reportFailure(taskId, entry, toErrorMessage(error));
			}
		} finally {
			// The next turn after a cancel starts from a clean slate; the session itself is kept.
			if (live.stoppedByKanban && live.pending.length === 0 && this.live.get(taskId) === live) {
				live.stoppedByKanban = false;
			}
			this.emitSummary(updateSummary(entry, { pid: null }));
		}
	}

	private release(taskId: string, live: LiveSession): void {
		live.unsubscribe?.();
		live.session?.dispose();
		if (this.live.get(taskId) === live) {
			this.live.delete(taskId);
		}
	}

	protected terminate(taskId: string): void {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		live.terminating = true;
		live.stoppedByKanban = true;
		live.pending.length = 0;
		void live.session?.abort().catch(() => undefined);
		if (!live.running) {
			this.release(taskId, live);
		}
	}

	protected async interruptTurn(taskId: string): Promise<void> {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		// Drop queued follow-ups too; the user canceled the work, not just the current step.
		live.pending.length = 0;
		live.stoppedByKanban = true;
		await live.session?.abort();
	}
}

export function createPiChatTaskSessionService(
	options: CreatePiChatTaskSessionServiceOptions = {},
): PiChatTaskSessionService {
	return new PiChatTaskSessionServiceImpl(options);
}
