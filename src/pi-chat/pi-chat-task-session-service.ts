// Native chat backend for Pi. Embeds the Pi coding agent SDK in-process (one AgentSession per
// task, persisted in a per-conversation session directory) and maps its events onto the same
// ClineTaskSessionService surface the chat UI already consumes for Cline, Claude and Codex.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ClineMessageRepository } from "../cline-sdk/cline-message-repository";
import { type ClineTaskSessionEntry, updateSummary } from "../cline-sdk/cline-session-state";
import type { RuntimeTaskImage } from "../core/api-contract";
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
	reducerState: PiReducerState;
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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

const createSdkSession: CreatePiChatSession = async (settings) => {
	const options: CreateAgentSessionOptions = {
		...buildPiSessionOptions(settings),
		// continueRecent resumes the conversation stored in the per-conversation directory, if any.
		sessionManager: SessionManager.continueRecent(settings.cwd, settings.sessionDir),
	};
	if (settings.modelId) {
		// Same convention as `pi --model`: "provider/id" or a bare model id.
		const modelRuntime = await ModelRuntime.create();
		const model = modelRuntime
			.getAvailableSnapshot()
			.find(
				(candidate) =>
					`${candidate.provider}/${candidate.id}` === settings.modelId || candidate.id === settings.modelId,
			);
		if (!model) {
			throw new Error(`Pi model "${settings.modelId}" is not available. Check your Pi credentials.`);
		}
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
			if (live.stoppedByKanban) {
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
		try {
			live.session ??= await this.openSession(taskId, entry, live);
			const isFirstTurn = live.session.messages.length === 0;
			const text = isFirstTurn && settings?.systemPrompt ? `${settings.systemPrompt}\n\n${turn.text}` : turn.text;
			await live.session.prompt(text, {
				images: turn.images?.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
			});
			if (!live.stoppedByKanban) {
				const error = live.reducerState.lastError;
				this.completeTurn(taskId, entry, error !== null, error ?? live.reducerState.lastAssistantText);
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
