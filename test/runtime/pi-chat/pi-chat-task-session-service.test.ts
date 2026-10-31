import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildPiSessionOptions,
	type CreatePiChatSession,
	createPiChatTaskSessionService,
	type PiChatSession,
	type PiSessionSettings,
} from "../../../src/pi-chat/pi-chat-task-session-service";

type Listener = (event: AgentSessionEvent) => void;
type PromptScript = (emit: Listener, signal: { aborted: boolean }) => Promise<void>;

function createFakeFactory(scripts: PromptScript[]) {
	const created: PiSessionSettings[] = [];
	const prompts: string[] = [];
	let turn = 0;
	const createSession: CreatePiChatSession = async (settings) => {
		created.push(settings);
		const listeners = new Set<Listener>();
		const signal = { aborted: false };
		const messages: unknown[] = [];
		const session = {
			messages,
			subscribe: (listener: Listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			prompt: async (text: string) => {
				prompts.push(text);
				messages.push({ role: "user" });
				const script = scripts[turn];
				turn += 1;
				await script?.((event) => {
					for (const listener of listeners) {
						listener(event);
					}
				}, signal);
			},
			abort: async () => {
				signal.aborted = true;
			},
			dispose: () => undefined,
		} as unknown as PiChatSession;
		return session;
	};
	return { createSession, created, prompts };
}

const assistantEnd = (text: string, stopReason = "stop", errorMessage?: string): AgentSessionEvent =>
	({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
	}) as unknown as AgentSessionEvent;

const textDelta = (delta: string): AgentSessionEvent =>
	({
		type: "message_update",
		message: {},
		assistantMessageEvent: { type: "text_delta", delta },
	}) as unknown as AgentSessionEvent;

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

describe("buildPiSessionOptions", () => {
	const base: PiSessionSettings = {
		cwd: "/w",
		sessionDir: "/s",
		modelId: null,
		reasoningEffort: null,
		planMode: false,
	};

	it("restricts plan mode to read-only tools", () => {
		expect(buildPiSessionOptions(base).tools).toBeUndefined();
		expect(buildPiSessionOptions({ ...base, planMode: true }).tools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("passes only valid thinking levels", () => {
		expect(buildPiSessionOptions({ ...base, reasoningEffort: "high" }).thinkingLevel).toBe("high");
		expect(buildPiSessionOptions({ ...base, reasoningEffort: "bogus" }).thinkingLevel).toBeUndefined();
	});
});

describe("pi chat task session service", () => {
	let stateDir: string;
	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "pi-chat-"));
	});
	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("streams a turn, lands in review, and keeps one session per task", async () => {
		const { createSession, created, prompts } = createFakeFactory([
			async (emit) => {
				emit(textDelta("he"));
				emit(textDelta("llo"));
				emit(assistantEnd("hello"));
			},
			async (emit) => emit(assistantEnd("again")),
		]);
		const service = createPiChatTaskSessionService({ createSession, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "hi", systemPrompt: "SYS" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(service.listMessages("t1").map((message) => [message.role, message.content])).toEqual([
			["user", "hi"],
			["assistant", "hello"],
		]);
		expect(service.getSummary("t1")?.reviewReason).toBe("hook");

		await service.sendTaskSessionInput("t1", "more");
		await waitFor(() => prompts.length === 2);
		expect(created).toHaveLength(1);
		expect(prompts).toEqual(["SYS\n\nhi", "more"]);
		await service.dispose();
	});

	it("reports an assistant error as an error review", async () => {
		const { createSession } = createFakeFactory([async (emit) => emit(assistantEnd("", "error", "rate limited"))]);
		const service = createPiChatTaskSessionService({ createSession, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "go" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(service.getSummary("t1")?.reviewReason).toBe("error");
		expect(service.listMessages("t1").some((message) => message.content.includes("rate limited"))).toBe(true);
		await service.dispose();
	});

	it("reports a session creation failure and stays usable", async () => {
		const service = createPiChatTaskSessionService({
			createSession: async () => {
				throw new Error('Pi model "x" is not available.');
			},
			stateDir,
		});
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "go", modelId: "x" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(service.getSummary("t1")?.reviewReason).toBe("error");
		await service.dispose();
	});

	it("cancel aborts the run without reporting a failure", async () => {
		let aborted = false;
		const { createSession } = createFakeFactory([
			async (_emit, signal) => {
				while (!signal.aborted) {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
				aborted = true;
			},
		]);
		const service = createPiChatTaskSessionService({ createSession, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "go" });
		await waitFor(() => service.getSummary("t1")?.state === "running");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await service.cancelTaskTurn("t1");
		await waitFor(() => aborted);

		expect(service.getSummary("t1")?.state).toBe("idle");
		expect(service.listMessages("t1").some((message) => message.role === "system")).toBe(false);
		await service.dispose();
	});
});
