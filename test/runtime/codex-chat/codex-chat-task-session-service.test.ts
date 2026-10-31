import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input, Thread, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildCodexThreadOptions,
	type CodexChatClient,
	createCodexChatTaskSessionService,
} from "../../../src/codex-chat/codex-chat-task-session-service";

interface FakeThread {
	thread: Thread;
	inputs: Input[];
	signals: (AbortSignal | undefined)[];
}

type TurnScript = (signal: AbortSignal | undefined) => AsyncGenerator<ThreadEvent>;

function createFakeClient(scripts: TurnScript[]) {
	const started: { options: ThreadOptions }[] = [];
	const resumed: { id: string; options: ThreadOptions }[] = [];
	const fakes: FakeThread[] = [];
	let turn = 0;
	const makeThread = (): Thread => {
		const fake: FakeThread = { thread: null as unknown as Thread, inputs: [], signals: [] };
		fake.thread = {
			id: "thread-1",
			runStreamed: async (input: Input, options?: { signal?: AbortSignal }) => {
				fake.inputs.push(input);
				fake.signals.push(options?.signal);
				const script = scripts[turn];
				turn += 1;
				if (!script) {
					throw new Error("no script");
				}
				return { events: script(options?.signal) };
			},
		} as unknown as Thread;
		fakes.push(fake);
		return fake.thread;
	};
	const client: CodexChatClient = {
		startThread: (options) => {
			started.push({ options: options ?? {} });
			return makeThread();
		},
		resumeThread: (id, options) => {
			resumed.push({ id, options: options ?? {} });
			return makeThread();
		},
	};
	return { client, started, resumed, fakes };
}

async function* completedTurn(text: string): AsyncGenerator<ThreadEvent> {
	yield { type: "thread.started", thread_id: "thread-1" };
	yield { type: "item.completed", item: { id: "a", type: "agent_message", text } };
	yield {
		type: "turn.completed",
		usage: {
			input_tokens: 1,
			cached_input_tokens: 0,
			output_tokens: 1,
			reasoning_output_tokens: 0,
			cache_write_input_tokens: 0,
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("timed out waiting for condition");
}

describe("buildCodexThreadOptions", () => {
	const base = { cwd: "/w", modelId: null, reasoningEffort: null, autonomousModeEnabled: false, planMode: false };

	it("maps modes to sandbox modes", () => {
		expect(buildCodexThreadOptions(base).sandboxMode).toBe("workspace-write");
		expect(buildCodexThreadOptions({ ...base, planMode: true }).sandboxMode).toBe("read-only");
		expect(buildCodexThreadOptions({ ...base, autonomousModeEnabled: true }).sandboxMode).toBe("danger-full-access");
	});

	it("passes model and valid effort only", () => {
		const options = buildCodexThreadOptions({ ...base, modelId: "gpt-x", reasoningEffort: "high" });
		expect(options).toMatchObject({ model: "gpt-x", modelReasoningEffort: "high", workingDirectory: "/w" });
		expect(buildCodexThreadOptions({ ...base, reasoningEffort: "bogus" }).modelReasoningEffort).toBeUndefined();
	});
});

describe("codex chat task session service", () => {
	let stateDir: string;
	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "codex-chat-"));
	});
	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	it("runs a turn, lands in review, and persists the thread id", async () => {
		const { client, started } = createFakeClient([() => completedTurn("hi")]);
		const service = createCodexChatTaskSessionService({ client, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "hello", systemPrompt: "SYS" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(started).toHaveLength(1);
		const messages = service.listMessages("t1");
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(service.getSummary("t1")?.reviewReason).toBe("hook");
		await service.dispose();
	});

	it("prepends the system prompt to the first input only", async () => {
		const { client, fakes } = createFakeClient([() => completedTurn("one"), () => completedTurn("two")]);
		const service = createCodexChatTaskSessionService({ client, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "first", systemPrompt: "SYS" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");
		await service.sendTaskSessionInput("t1", "second");
		await waitFor(() => fakes[0]?.inputs.length === 2);

		expect(fakes[0]?.inputs[0]).toBe("SYS\n\nfirst");
		expect(fakes[0]?.inputs[1]).toBe("second");
		await service.dispose();
	});

	it("reports a failed turn as an error review", async () => {
		const { client } = createFakeClient([
			async function* () {
				yield { type: "turn.failed", error: { message: "rate limited" } };
			},
		]);
		const service = createCodexChatTaskSessionService({ client, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "go" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(service.getSummary("t1")?.reviewReason).toBe("error");
		expect(service.listMessages("t1").some((message) => message.content.includes("rate limited"))).toBe(true);
		await service.dispose();
	});

	it("cancels a running turn without reporting a failure", async () => {
		const { client, fakes } = createFakeClient([
			async function* (signal) {
				yield { type: "thread.started", thread_id: "thread-1" };
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			},
		]);
		const service = createCodexChatTaskSessionService({ client, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "long" });
		await waitFor(() => (fakes[0]?.signals.length ?? 0) === 1);
		const summary = await service.cancelTaskTurn("t1");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(summary?.state).toBe("idle");
		expect(service.getSummary("t1")?.state).toBe("idle");
		expect(service.listMessages("t1").some((message) => message.role === "system")).toBe(false);
		expect(fakes[0]?.signals[0]?.aborted).toBe(true);
		await service.dispose();
	});

	it("resumes the persisted thread after a restart", async () => {
		const first = createFakeClient([() => completedTurn("hi")]);
		const service = createCodexChatTaskSessionService({ client: first.client, stateDir });
		await service.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "hello" });
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");
		await service.dispose();

		const second = createFakeClient([() => completedTurn("again")]);
		const restarted = createCodexChatTaskSessionService({ client: second.client, stateDir });
		await restarted.startTaskSession({ taskId: "t1", cwd: "/w", prompt: "more", resumeFromPersistence: true });
		await waitFor(() => restarted.getSummary("t1")?.state === "awaiting_review");

		expect(second.resumed).toEqual([
			{ id: "thread-1", options: expect.objectContaining({ workingDirectory: "/w" }) },
		]);
		expect(second.started).toHaveLength(0);
		await restarted.dispose();
	});
});
