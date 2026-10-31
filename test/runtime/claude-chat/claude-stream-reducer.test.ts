import { describe, expect, it } from "vitest";
import {
	type ClaudeStreamReduction,
	createClaudeStreamReducerState,
	reduceClaudeStreamEvent,
} from "../../../src/claude-chat/claude-stream-reducer";
import { type ClineTaskSessionEntry, createDefaultSummary } from "../../../src/cline-sdk/cline-session-state";

function createEntry(): ClineTaskSessionEntry {
	return {
		summary: createDefaultSummary("task-1"),
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map(),
		toolInputByToolCallId: new Map(),
	};
}

function streamEvents(events: unknown[]): { entry: ClineTaskSessionEntry; reductions: ClaudeStreamReduction[] } {
	const entry = createEntry();
	const state = createClaudeStreamReducerState();
	const reductions = events.map((event) => reduceClaudeStreamEvent("task-1", entry, state, event));
	return { entry, reductions };
}

const textDelta = (text: string) => ({
	type: "stream_event",
	event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});

describe("reduceClaudeStreamEvent", () => {
	it("reports init info", () => {
		const { reductions } = streamEvents([
			{ type: "system", subtype: "init", session_id: "s1", model: "m", slash_commands: ["review"], skills: ["pdf"] },
		]);
		expect(reductions[0]?.init).toEqual({ sessionId: "s1", model: "m", slashCommands: ["review"], skills: ["pdf"] });
	});

	it("streams text into one assistant message and does not duplicate it from the complete message", () => {
		const { entry } = streamEvents([
			{ type: "stream_event", event: { type: "message_start", message: { id: "msg_1" } } },
			{ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } },
			textDelta("Hel"),
			textDelta("lo"),
			{ type: "stream_event", event: { type: "content_block_stop" } },
			{ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] } },
		]);
		expect(entry.messages.map((m) => [m.role, m.content])).toEqual([["assistant", "Hello"]]);
	});

	it("falls back to the complete assistant message when nothing streamed", () => {
		const { entry } = streamEvents([
			{ type: "assistant", message: { id: "msg_2", content: [{ type: "text", text: "Hi" }] } },
		]);
		expect(entry.messages.map((m) => m.content)).toEqual(["Hi"]);
	});

	it("streams thinking into a reasoning message", () => {
		const { entry } = streamEvents([
			{ type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
			{ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } },
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
			},
		]);
		expect(entry.messages[0]).toMatchObject({ role: "reasoning", content: "hmm" });
	});

	it("opens a tool card on start, fills the input from the complete message and closes on tool_result", () => {
		const { entry } = streamEvents([
			{ type: "stream_event", event: { type: "message_start", message: { id: "m" } } },
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
				},
			},
			{
				type: "assistant",
				message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
			},
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } },
		]);
		expect(entry.messages).toHaveLength(1);
		expect(entry.messages[0]?.meta?.hookEventName).toBe("tool_call_end");
		expect(entry.messages[0]?.content).toContain("ls");
		expect(entry.messages[0]?.content).toContain("a.txt");
	});

	it("marks failed tool results as errors", () => {
		const { entry } = streamEvents([
			{
				type: "assistant",
				message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }] },
			},
			{
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] },
					],
				},
			},
		]);
		expect(entry.messages[0]?.content).toContain("Error:\nboom");
	});

	it("reports the turn result", () => {
		const { reductions } = streamEvents([{ type: "result", subtype: "success", is_error: false, result: "done" }]);
		expect(reductions[0]?.turnResult).toEqual({ isError: false, text: "done" });
		const failed = streamEvents([{ type: "result", subtype: "error_max_turns" }]);
		expect(failed.reductions[0]?.turnResult?.isError).toBe(true);
	});
});
