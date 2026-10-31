import type { ThreadEvent } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { type ClineTaskSessionEntry, createDefaultSummary } from "../../../src/cline-sdk/cline-session-state";
import { createCodexReducerState, reduceCodexEvent } from "../../../src/codex-chat/codex-event-reducer";

function createEntry(): ClineTaskSessionEntry {
	return {
		summary: createDefaultSummary("t1"),
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map(),
		toolInputByToolCallId: new Map(),
	};
}

function run(events: ThreadEvent[]) {
	const entry = createEntry();
	const state = createCodexReducerState();
	const reductions = events.map((event) => reduceCodexEvent("t1", entry, state, event));
	return { entry, reductions };
}

describe("reduceCodexEvent", () => {
	it("reports the thread id", () => {
		const { reductions } = run([{ type: "thread.started", thread_id: "th1" }]);
		expect(reductions[0]?.threadId).toBe("th1");
	});

	it("creates an agent message once and updates it in place", () => {
		const { entry } = run([
			{ type: "item.started", item: { id: "a", type: "agent_message", text: "Hel" } },
			{ type: "item.updated", item: { id: "a", type: "agent_message", text: "Hello" } },
			{ type: "item.completed", item: { id: "a", type: "agent_message", text: "Hello there" } },
		]);
		expect(entry.messages).toHaveLength(1);
		expect(entry.messages[0]).toMatchObject({ role: "assistant", content: "Hello there" });
	});

	it("opens and finishes a command tool card", () => {
		const { entry } = run([
			{
				type: "item.started",
				item: { id: "c", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" },
			},
			{
				type: "item.completed",
				item: {
					id: "c",
					type: "command_execution",
					command: "ls",
					aggregated_output: "a.txt",
					exit_code: 0,
					status: "completed",
				},
			},
		]);
		const tools = entry.messages.filter((message) => message.role === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]?.content).toContain("a.txt");
	});

	it("marks a non-zero exit as a tool error", () => {
		const { entry } = run([
			{
				type: "item.completed",
				item: {
					id: "c",
					type: "command_execution",
					command: "false",
					aggregated_output: "",
					exit_code: 1,
					status: "failed",
				},
			},
		]);
		expect(entry.messages.find((message) => message.role === "tool")?.content).toContain("code 1");
	});

	it("turns an error item into a system message", () => {
		const { entry } = run([{ type: "item.completed", item: { id: "e", type: "error", message: "boom" } }]);
		expect(entry.messages[0]).toMatchObject({ role: "system", content: "boom" });
	});

	it("completes a turn with the last agent text", () => {
		const { reductions } = run([
			{ type: "item.completed", item: { id: "a", type: "agent_message", text: "done" } },
			{
				type: "turn.completed",
				usage: {
					input_tokens: 1,
					cached_input_tokens: 0,
					output_tokens: 1,
					reasoning_output_tokens: 0,
					cache_write_input_tokens: 0,
				},
			},
		]);
		expect(reductions[1]?.turnResult).toEqual({ isError: false, text: "done" });
	});

	it("fails a turn on turn.failed and on error events", () => {
		const { reductions } = run([
			{ type: "turn.failed", error: { message: "nope" } },
			{ type: "error", message: "fatal" },
		]);
		expect(reductions[0]?.turnResult).toEqual({ isError: true, text: "nope" });
		expect(reductions[1]?.turnResult).toEqual({ isError: true, text: "fatal" });
	});
});
