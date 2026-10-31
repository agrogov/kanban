// Native chat backend for OpenAI Codex. Drives the Codex SDK (`@openai/codex-sdk`), which runs
// one `codex exec` per turn and resumes the conversation by thread id, and maps its events onto
// the same ClineTaskSessionService surface the chat UI already consumes for Cline and Claude.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	Codex,
	type ModelReasoningEffort,
	type SandboxMode,
	type Thread,
	type ThreadOptions,
	type UserInput,
} from "@openai/codex-sdk";
import type { ClineMessageRepository } from "../cline-sdk/cline-message-repository";
import { type ClineTaskSessionEntry, updateSummary } from "../cline-sdk/cline-session-state";
import type { RuntimeTaskImage } from "../core/api-contract";
import type { NativeChatBackend } from "../native-chat/chat-backend";
import { NativeChatSessionService, toErrorMessage } from "../native-chat/native-chat-session-service";
import { resolveBinaryOnPath } from "../terminal/command-discovery";
import { type CodexReducerState, createCodexReducerState, reduceCodexEvent } from "./codex-event-reducer";

export const CODEX_CHAT_AGENT_ID = "codex-chat";
const HOOK_SOURCE = "codex-chat";

export type CodexChatTaskSessionService = NativeChatBackend;

/** The slice of the SDK client the service uses, so tests can inject a fake. */
export type CodexChatClient = Pick<Codex, "startThread" | "resumeThread">;

export interface CreateCodexChatTaskSessionServiceOptions {
	/** Path to a specific `codex` binary; defaults to `codex` on PATH, then the SDK's bundled one. */
	binary?: string | null;
	stateDir?: string;
	client?: CodexChatClient;
	messageRepository?: ClineMessageRepository;
}

interface PendingTurn {
	text: string;
	images: RuntimeTaskImage[] | undefined;
}

interface LiveSession {
	thread: Thread | null;
	pending: PendingTurn[];
	running: boolean;
	abort: AbortController | null;
	/** Kanban ended or canceled the work on purpose, so the aborted stream is not a failure. */
	stoppedByKanban: boolean;
	reducerState: CodexReducerState;
}

interface ThreadSettings {
	cwd: string;
	modelId: string | null;
	reasoningEffort: string | null;
	autonomousModeEnabled: boolean;
	planMode: boolean;
}

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
	"persistent",
]);

function resolveSandboxMode(settings: ThreadSettings): SandboxMode {
	if (settings.planMode) {
		return "read-only";
	}
	// Matches the terminal catalog entry: autonomous means --dangerously-bypass-approvals-and-sandbox.
	return settings.autonomousModeEnabled ? "danger-full-access" : "workspace-write";
}

export function buildCodexThreadOptions(settings: ThreadSettings): ThreadOptions {
	const options: ThreadOptions = {
		workingDirectory: settings.cwd,
		skipGitRepoCheck: true,
		sandboxMode: resolveSandboxMode(settings),
		// The SDK has no per-tool approval callback, so never block on a prompt nobody can answer.
		approvalPolicy: "never",
	};
	if (settings.modelId) {
		options.model = settings.modelId;
	}
	if (settings.reasoningEffort && EFFORT_LEVELS.has(settings.reasoningEffort)) {
		options.modelReasoningEffort = settings.reasoningEffort as ModelReasoningEffort;
	}
	return options;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

class CodexChatTaskSessionServiceImpl extends NativeChatSessionService {
	private readonly binary: string | null | undefined;
	private client: CodexChatClient | null;
	private readonly live = new Map<string, LiveSession>();

	constructor(options: CreateCodexChatTaskSessionServiceOptions) {
		super(
			{ agentId: CODEX_CHAT_AGENT_ID, displayName: "Codex", hookSource: HOOK_SOURCE, stateDirName: "codex-chat" },
			options,
		);
		this.binary = options.binary;
		this.client = options.client ?? null;
	}

	protected createInitialSessionId(): string | null {
		// Codex assigns the thread id itself, on the first turn.
		return null;
	}

	protected liveTaskIds(): string[] {
		return [...this.live.keys()];
	}

	protected dispatch(
		taskId: string,
		entry: ClineTaskSessionEntry,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		canResume: boolean,
	): void {
		let live = this.live.get(taskId);
		if (!live) {
			live = {
				thread: null,
				pending: [],
				running: false,
				abort: null,
				stoppedByKanban: false,
				reducerState: createCodexReducerState(),
			};
			this.live.set(taskId, live);
		}
		live.pending.push({ text, images });
		if (!live.running) {
			void this.drain(taskId, entry, live, canResume);
		}
	}

	private getClient(): CodexChatClient {
		if (!this.client) {
			const binary =
				this.binary === undefined ? resolveBinaryOnPath("codex", { skipNodeModulesBin: true }) : this.binary;
			this.client = new Codex(binary ? { codexPathOverride: binary } : {});
		}
		return this.client;
	}

	private openThread(taskId: string, entry: ClineTaskSessionEntry, canResume: boolean): Thread {
		const settings = this.settingsByTaskId.get(taskId);
		if (!settings) {
			throw new Error(`No Codex chat settings for task ${taskId}.`);
		}
		const options = buildCodexThreadOptions({
			cwd: settings.cwd,
			modelId: settings.modelId,
			reasoningEffort: settings.reasoningEffort,
			autonomousModeEnabled: settings.autonomousModeEnabled,
			planMode: settings.mode === "plan",
		});
		const hasHistory = canResume && entry.messages.some((message) => message.role === "assistant");
		return settings.sessionId && hasHistory
			? this.getClient().resumeThread(settings.sessionId, options)
			: this.getClient().startThread(options);
	}

	private async drain(
		taskId: string,
		entry: ClineTaskSessionEntry,
		live: LiveSession,
		canResume: boolean,
	): Promise<void> {
		live.running = true;
		try {
			while (live.pending.length > 0 && !live.stoppedByKanban) {
				const turn = live.pending.shift();
				if (turn) {
					await this.runTurn(taskId, entry, live, turn, canResume);
					canResume = true;
				}
			}
		} finally {
			live.running = false;
			if (live.stoppedByKanban && this.live.get(taskId) === live) {
				this.live.delete(taskId);
			}
		}
	}

	private async runTurn(
		taskId: string,
		entry: ClineTaskSessionEntry,
		live: LiveSession,
		turn: PendingTurn,
		canResume: boolean,
	): Promise<void> {
		const settings = this.settingsByTaskId.get(taskId);
		const controller = new AbortController();
		live.abort = controller;
		let turnFinished = false;
		const imagePaths: string[] = [];
		try {
			const isFirstTurnOfThread = !live.thread;
			live.thread ??= this.openThread(taskId, entry, canResume);
			const thread = live.thread;
			const hasHistory = entry.messages.some((message) => message.role === "assistant");
			const prompt =
				isFirstTurnOfThread && !hasHistory && settings?.systemPrompt
					? `${settings.systemPrompt}\n\n${turn.text}`
					: turn.text;
			const input = await this.buildInput(taskId, prompt, turn.images, imagePaths);
			const { events } = await thread.runStreamed(input, { signal: controller.signal });
			for await (const event of events) {
				const reduction = reduceCodexEvent(taskId, entry, live.reducerState, event);
				this.emitMessages(taskId, entry, reduction.changedMessages);
				this.setSessionId(taskId, reduction.threadId ?? thread.id);
				if (reduction.turnResult && !turnFinished) {
					turnFinished = true;
					this.completeTurn(taskId, entry, reduction.turnResult.isError, reduction.turnResult.text);
				}
			}
			if (!turnFinished && !live.stoppedByKanban) {
				this.reportFailure(taskId, entry, "Codex exited unexpectedly.");
			}
		} catch (error) {
			if (!live.stoppedByKanban && !turnFinished) {
				this.reportFailure(taskId, entry, toErrorMessage(error));
			}
		} finally {
			live.abort = null;
			// The next turn after a cancel starts from a clean slate; the thread itself is kept.
			if (live.stoppedByKanban && live.pending.length === 0 && this.live.get(taskId) === live) {
				live.stoppedByKanban = false;
			}
			await Promise.all(imagePaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
			this.emitSummary(updateSummary(entry, { pid: null }));
		}
	}

	private async buildInput(
		taskId: string,
		text: string,
		images: RuntimeTaskImage[] | undefined,
		writtenPaths: string[],
	): Promise<string | UserInput[]> {
		if (!images || images.length === 0) {
			return text;
		}
		// The SDK only accepts images as file paths.
		await mkdir(this.scratchDir, { recursive: true });
		const parts: UserInput[] = [];
		for (const [index, image] of images.entries()) {
			const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "png";
			const path = join(
				this.scratchDir,
				`${taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}-${index}.${extension}`,
			);
			await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
			writtenPaths.push(path);
			parts.push({ type: "local_image", path });
		}
		parts.push({ type: "text", text });
		return parts;
	}

	protected terminate(taskId: string): void {
		const live = this.live.get(taskId);
		if (!live) {
			return;
		}
		live.stoppedByKanban = true;
		live.pending.length = 0;
		live.abort?.abort();
		if (!live.running) {
			this.live.delete(taskId);
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
		live.abort?.abort();
	}
}

export function createCodexChatTaskSessionService(
	options: CreateCodexChatTaskSessionServiceOptions = {},
): CodexChatTaskSessionService {
	return new CodexChatTaskSessionServiceImpl(options);
}
