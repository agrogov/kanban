import { describe, expect, it, vi } from "vitest";

import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { NativeChatBackend } from "../../../src/native-chat/chat-backend";
import { createCompositeChatTaskSessionService } from "../../../src/native-chat/composite-chat-task-session-service";

function createStubBackend(owned: string[]) {
	const startTaskSession = vi.fn(async () => ({ taskId: "started" }));
	const cancelTaskTurn = vi.fn(async () => null);
	const backend = {
		onSummary: () => () => undefined,
		onMessage: () => () => undefined,
		startTaskSession,
		cancelTaskTurn,
		getSummary: (taskId: string) => (owned.includes(taskId) ? { taskId } : null),
		hasTask: async (taskId: string) => owned.includes(taskId),
		listSummaries: () => owned.map((taskId) => ({ taskId })),
		listSlashCommands: () => [{ name: "from-backend", instructions: "/from-backend" }],
		dispose: vi.fn(async () => undefined),
	};
	return { backend: backend as unknown as NativeChatBackend, startTaskSession, cancelTaskTurn };
}

function createClineStub() {
	const startTaskSession = vi.fn(async () => ({ taskId: "cline-started" }));
	const cancelTaskTurn = vi.fn(async () => null);
	const cline = {
		onSummary: () => () => undefined,
		onMessage: () => () => undefined,
		startTaskSession,
		cancelTaskTurn,
		getSummary: () => null,
		listSummaries: () => [],
		listSlashCommands: vi.fn(async () => [{ name: "from-cline", instructions: "/from-cline" }]),
		dispose: vi.fn(async () => undefined),
	};
	return { cline: cline as unknown as ClineTaskSessionService, startTaskSession, cancelTaskTurn };
}

describe("createCompositeChatTaskSessionService", () => {
	it("routes start by agent id and defaults to Cline", async () => {
		const claude = createStubBackend([]);
		const codex = createStubBackend([]);
		const cline = createClineStub();
		const composite = createCompositeChatTaskSessionService(cline.cline, [
			{ agentId: "claude-chat", service: claude.backend },
			{ agentId: "codex-chat", service: codex.backend },
		]);
		const base = { taskId: "t", cwd: "/w", prompt: "p" };

		await composite.startTaskSession({ ...base, agentId: "codex-chat" });
		await composite.startTaskSession({ ...base, agentId: "cline" });

		expect(codex.startTaskSession).toHaveBeenCalledTimes(1);
		expect(claude.startTaskSession).not.toHaveBeenCalled();
		expect(cline.startTaskSession).toHaveBeenCalledTimes(1);
	});

	it("routes per-task calls to the backend that owns the task", async () => {
		const claude = createStubBackend(["a"]);
		const codex = createStubBackend(["b"]);
		const cline = createClineStub();
		const composite = createCompositeChatTaskSessionService(cline.cline, [
			{ agentId: "claude-chat", service: claude.backend },
			{ agentId: "codex-chat", service: codex.backend },
		]);

		await composite.cancelTaskTurn("b");
		await composite.cancelTaskTurn("other");

		expect(codex.cancelTaskTurn).toHaveBeenCalledWith("b");
		expect(claude.cancelTaskTurn).not.toHaveBeenCalled();
		expect(cline.cancelTaskTurn).toHaveBeenCalledWith("other");
		expect(composite.listSummaries().map((summary) => summary.taskId)).toEqual(["a", "b"]);
	});

	it("serves slash commands from the owning backend", async () => {
		const codex = createStubBackend(["b"]);
		const cline = createClineStub();
		const composite = createCompositeChatTaskSessionService(cline.cline, [
			{ agentId: "codex-chat", service: codex.backend },
		]);

		expect((await composite.listSlashCommands("/w", "b")).map((command) => command.name)).toEqual(["from-backend"]);
		expect((await composite.listSlashCommands("/w", "x")).map((command) => command.name)).toEqual(["from-cline"]);
	});
});
