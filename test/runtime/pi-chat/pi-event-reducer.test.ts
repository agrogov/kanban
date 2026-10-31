import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { type ClineTaskSessionEntry, createDefaultSummary } from "../../../src/cline-sdk/cline-session-state";
import { createPiReducerState, reducePiEvent } from "../../../src/pi-chat/pi-event-reducer";

function createEntry(): ClineTaskSessionEntry {
	return {
		summary: createDefaultSummary("t1"),
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map(),
		toolInputByToolCallId: new Map(),
	} as unknown as ClineTaskSessionEntry;
}

const update = (assistantMessageEvent: Record<string, unknown>) =>
	({ type: "message_update", message: {}, assistantMessageEvent }) as unknown as AgentSessionEvent;

describe("reducePiEvent", () => {
	it("accumulates text deltas into one assistant message per text block", () => {
		const entry = createEntry();
		const state = createPiReducerState();
		reducePiEvent("t1", entry, state, update({ type: "text_start" }));
		reducePiEvent("t1", entry, state, update({ type: "text_delta", delta: "a" }));
		reducePiEvent("t1", entry, state, update({ type: "text_delta", delta: "b" }));
		reducePiEvent("t1", entry, state, update({ type: "text_end", content: "ab" }));
		reducePiEvent("t1", entry, state, update({ type: "text_start" }));
		reducePiEvent("t1", entry, state, update({ type: "text_delta", delta: "c" }));

		expect(entry.messages.map((message) => message.content)).toEqual(["ab", "c"]);
	});

	it("renders thinking as a reasoning message", () => {
		const entry = createEntry();
		const state = createPiReducerState();
		reducePiEvent("t1", entry, state, update({ type: "thinking_start" }));
		reducePiEvent("t1", entry, state, update({ type: "thinking_delta", delta: "hmm" }));

		expect(entry.messages.map((message) => message.role)).toEqual(["reasoning"]);
	});

	it("opens and finishes a tool card", () => {
		const entry = createEntry();
		const state = createPiReducerState();
		reducePiEvent("t1", entry, state, {
			type: "tool_execution_start",
			toolCallId: "c1",
			toolName: "bash",
			args: { command: "ls" },
		} as AgentSessionEvent);
		const { changedMessages } = reducePiEvent("t1", entry, state, {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom" }] },
			isError: true,
		} as AgentSessionEvent);

		expect(entry.messages).toHaveLength(1);
		expect(changedMessages[0]?.meta?.toolName).toBe("bash");
		expect(changedMessages[0]?.content).toContain("boom");
	});

	it("tracks the last assistant text and error", () => {
		const entry = createEntry();
		const state = createPiReducerState();
		reducePiEvent("t1", entry, state, {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		} as unknown as AgentSessionEvent);
		expect(state).toMatchObject({ lastAssistantText: "done", lastError: null });

		reducePiEvent("t1", entry, state, {
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "nope" },
		} as unknown as AgentSessionEvent);
		expect(state.lastError).toBe("nope");
	});
});
