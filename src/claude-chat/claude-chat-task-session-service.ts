// Native chat backend for Claude Code. Drives the Claude Agent SDK in streaming-input mode (one
// long-lived query per task) and maps its messages onto the same ClineTaskSessionService surface
// the chat UI, state hub and auto-review reconciler already consume for Cline.

import { randomUUID } from "node:crypto";
import { type Options, type Query, type SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ClineMessageRepository } from "../cline-sdk/cline-message-repository";
import { type ClineTaskSessionEntry, updateSummary } from "../cline-sdk/cline-session-state";
import type { RuntimeTaskImage } from "../core/api-contract";
import type { NativeChatBackend, StartNativeChatSessionRequest } from "../native-chat/chat-backend";
import { NativeChatSessionService, toErrorMessage } from "../native-chat/native-chat-session-service";
import { resolveBinaryOnPath } from "../terminal/command-discovery";
import { AsyncMessageQueue } from "./async-message-queue";
import {
	type ClaudeStreamReducerState,
	createClaudeStreamReducerState,
	reduceClaudeStreamEvent,
} from "./claude-stream-reducer";

export const CLAUDE_CHAT_AGENT_ID = "claude-chat";
const HOOK_SOURCE = "claude-chat";

export type StartClaudeChatSessionRequest = StartNativeChatSessionRequest;
export type ClaudeChatTaskSessionService = NativeChatBackend;

export type ClaudeChatQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface CreateClaudeChatTaskSessionServiceOptions {
	/** Path to a specific `claude` binary; defaults to `claude` on PATH, then the SDK's bundled one. */
	binary?: string | null;
	stateDir?: string;
	query?: ClaudeChatQuery;
	messageRepository?: ClineMessageRepository;
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

class ClaudeChatTaskSessionServiceImpl extends NativeChatSessionService {
	private readonly binary: string | null | undefined;
	private readonly runQuery: ClaudeChatQuery;
	private readonly live = new Map<string, LiveSession>();

	constructor(options: CreateClaudeChatTaskSessionServiceOptions) {
		super(
			{ agentId: CLAUDE_CHAT_AGENT_ID, displayName: "Claude", hookSource: HOOK_SOURCE, stateDirName: "claude-chat" },
			options,
		);
		this.binary = options.binary;
		this.runQuery = options.query ?? sdkQuery;
	}

	protected createInitialSessionId(): string {
		return randomUUID();
	}

	protected dispatch(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		canResume: boolean,
	): void {
		this.ensureSession(taskId, entry, canResume).input.push(buildClaudeUserMessage(text, images));
	}

	protected liveTaskIds(): string[] {
		return [...this.live.keys()];
	}

	private ensureSession(taskId: string, entry: ClineTaskSessionEntry, canResume: boolean): LiveSession {
		const existing = this.live.get(taskId);
		if (existing) {
			return existing;
		}
		const settings = this.settingsByTaskId.get(taskId);
		if (!settings?.sessionId) {
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
		this.emitMessages(taskId, entry, reduction.changedMessages);
		if (reduction.init) {
			this.setSessionId(taskId, reduction.init.sessionId);
			this.setSlashCommands([...reduction.init.slashCommands, ...reduction.init.skills]);
			this.setModelId(entry, reduction.init.model);
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

	protected terminate(taskId: string): void {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		live.terminatedByKanban = true;
		this.live.delete(taskId);
		live.input.close();
		live.query.close();
	}

	protected async interruptTurn(taskId: string): Promise<void> {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		// interrupt() keeps the query (and its session) alive for the next message.
		live.interruptPending = true;
		try {
			await live.query.interrupt();
		} catch {
			live.interruptPending = false;
			this.terminate(taskId);
		}
	}
}

export function createClaudeChatTaskSessionService(
	options: CreateClaudeChatTaskSessionServiceOptions = {},
): ClaudeChatTaskSessionService {
	return new ClaudeChatTaskSessionServiceImpl(options);
}
