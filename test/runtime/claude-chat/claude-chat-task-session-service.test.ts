import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AsyncMessageQueue } from "../../../src/claude-chat/async-message-queue";
import {
	buildClaudeQueryOptions,
	buildClaudeUserMessage,
	createClaudeChatTaskSessionService,
} from "../../../src/claude-chat/claude-chat-task-session-service";

interface FakeQuery {
	query: Query;
	emit(message: unknown): void;
	end(): void;
	received: SDKUserMessage[];
	interrupt: { count: number };
	closed: { value: boolean };
	options: Options;
}

function createFakeQuery(prompt: AsyncIterable<SDKUserMessage>, options: Options): FakeQuery {
	const outbound = new AsyncMessageQueue<unknown>();
	const received: SDKUserMessage[] = [];
	const interrupt = { count: 0 };
	const closed = { value: false };
	void (async () => {
		for await (const message of prompt) {
			received.push(message);
		}
	})();
	const iterator = outbound[Symbol.asyncIterator]();
	const fake = {
		next: () => iterator.next(),
		return: () => iterator.return?.() ?? Promise.resolve({ value: undefined, done: true }),
		throw: (error: unknown) => Promise.reject(error),
		[Symbol.asyncIterator]() {
			return fake;
		},
		interrupt: async () => {
			interrupt.count += 1;
		},
		close: () => {
			closed.value = true;
			outbound.close();
		},
	};
	return {
		query: fake as unknown as Query,
		emit: (message) => outbound.push(message),
		end: () => outbound.close(),
		received,
		interrupt,
		closed,
		options,
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

const initEvent = {
	type: "system",
	subtype: "init",
	session_id: "s1",
	model: "m",
	slash_commands: ["review"],
	skills: [],
};
const textResult = { type: "result", subtype: "success", is_error: false, result: "done" };

describe("claude chat task session service", () => {
	let stateDir: string;
	let fakes: FakeQuery[];

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "claude-chat-"));
		fakes = [];
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	function createService() {
		return createClaudeChatTaskSessionService({
			stateDir,
			binary: null,
			query: ({ prompt, options }) => {
				const fake = createFakeQuery(prompt, options);
				fakes.push(fake);
				return fake.query;
			},
		});
	}

	it("streams a turn into messages and moves to review on result", async () => {
		const service = createService();
		await service.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "hello" });
		await waitFor(() => fakes[0]?.received.length === 1);
		expect(fakes[0]?.received[0]?.message.content).toBe("hello");

		fakes[0]?.emit(initEvent);
		fakes[0]?.emit({
			type: "assistant",
			message: { id: "a1", content: [{ type: "text", text: "hi there" }] },
		});
		fakes[0]?.emit(textResult);
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		expect(service.getSummary("t1")?.reviewReason).toBe("hook");
		expect(service.listMessages("t1").map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(service.listSlashCommands().some((command) => command.name === "review")).toBe(true);
		await service.dispose();
	});

	it("reuses the same query for follow-up messages", async () => {
		const service = createService();
		await service.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "one" });
		fakes[0]?.emit(textResult);
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");

		await service.sendTaskSessionInput("t1", "two");
		await waitFor(() => fakes[0]?.received.length === 2);
		expect(fakes).toHaveLength(1);
		expect(service.getSummary("t1")?.state).toBe("running");
		await service.dispose();
	});

	it("interrupts on cancel and ignores the resulting error result", async () => {
		const service = createService();
		await service.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "go" });
		await service.cancelTaskTurn("t1");
		expect(fakes[0]?.interrupt.count).toBe(1);
		expect(service.getSummary("t1")?.state).toBe("idle");

		fakes[0]?.emit({ type: "result", subtype: "error_during_execution", is_error: true, result: null });
		await service.sendTaskSessionInput("t1", "again");
		fakes[0]?.emit(textResult);
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");
		expect(service.getSummary("t1")?.reviewReason).toBe("hook");
		expect(fakes).toHaveLength(1);
		await service.dispose();
	});

	it("reports a failure when the stream ends mid-turn", async () => {
		const service = createService();
		await service.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "go" });
		fakes[0]?.end();
		await waitFor(() => service.getSummary("t1")?.state === "awaiting_review");
		expect(service.getSummary("t1")?.reviewReason).toBe("error");
		await service.dispose();
	});

	it("closes the query on stop and does not report a failure", async () => {
		const service = createService();
		await service.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "go" });
		const summary = await service.stopTaskSession("t1");
		expect(fakes[0]?.closed.value).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(summary?.state).toBe("interrupted");
		expect(service.getSummary("t1")?.reviewReason).toBe("interrupted");
		await service.dispose();
	});

	it("resumes the stored session after a restart", async () => {
		const first = createService();
		await first.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "go" });
		fakes[0]?.emit(initEvent);
		fakes[0]?.emit({ type: "assistant", message: { id: "a1", content: [{ type: "text", text: "ok" }] } });
		fakes[0]?.emit(textResult);
		await waitFor(() => first.getSummary("t1")?.state === "awaiting_review");
		await first.dispose();

		const second = createService();
		await second.startTaskSession({ taskId: "t1", cwd: "/work", prompt: "more", resumeFromPersistence: true });
		expect(fakes[1]?.options.resume).toBeTruthy();
		expect(fakes[1]?.options.sessionId).toBeUndefined();
		expect(second.listMessages("t1").length).toBeGreaterThan(1);
		await second.dispose();
	});
});

describe("buildClaudeQueryOptions", () => {
	const base = {
		cwd: "/work",
		sessionId: "abc",
		resume: false,
		modelId: null,
		reasoningEffort: null,
		autonomousModeEnabled: false,
		planMode: false,
		systemPrompt: null,
		binary: null,
	};

	it("starts a new session with its id", () => {
		const options = buildClaudeQueryOptions(base);
		expect(options.sessionId).toBe("abc");
		expect(options.resume).toBeUndefined();
		expect(options.permissionMode).toBeUndefined();
	});

	it("maps plan, autonomous, model, effort and prompt settings", () => {
		const options = buildClaudeQueryOptions({
			...base,
			resume: true,
			autonomousModeEnabled: true,
			modelId: "opus",
			reasoningEffort: "high",
			systemPrompt: "extra",
		});
		expect(options.resume).toBe("abc");
		expect(options.permissionMode).toBe("auto");
		expect(options.model).toBe("opus");
		expect(options.effort).toBe("high");
		expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "extra" });
		expect(buildClaudeQueryOptions({ ...base, planMode: true, autonomousModeEnabled: true }).permissionMode).toBe(
			"plan",
		);
	});

	it("drops unknown reasoning effort values", () => {
		expect(buildClaudeQueryOptions({ ...base, reasoningEffort: "bogus" }).effort).toBeUndefined();
	});
});

describe("buildClaudeUserMessage", () => {
	it("sends plain text as a string and images as content blocks", () => {
		expect(buildClaudeUserMessage("hi").message.content).toBe("hi");
		const withImage = buildClaudeUserMessage("hi", [{ id: "i", data: "AAA", mimeType: "image/png" }]);
		expect(withImage.message.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
			{ type: "text", text: "hi" },
		]);
	});
});
