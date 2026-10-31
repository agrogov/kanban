// Pure reducer from Claude Code `--output-format stream-json` events to Kanban chat messages.
// It mutates a ClineTaskSessionEntry (the shape the chat UI already consumes) and reports which
// messages changed so the caller can fan them out. Process and state-machine concerns live in
// claude-chat-task-session-service.ts.
import {
	appendAssistantChunk,
	appendReasoningChunk,
	buildToolCallContent,
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	clearActiveTurnState,
	createAssistantMessage,
	createMessage,
	finishToolCallMessage,
	startToolCallMessage,
	updateMessageInEntry,
} from "../cline-sdk/cline-session-state";

export interface ClaudeStreamReducerState {
	/** Assistant message ids whose text already arrived through partial stream events. */
	streamedMessageIds: Set<string>;
	currentStreamMessageId: string | null;
	toolNameByToolCallId: Map<string, string>;
}

export function createClaudeStreamReducerState(): ClaudeStreamReducerState {
	return {
		streamedMessageIds: new Set(),
		currentStreamMessageId: null,
		toolNameByToolCallId: new Map(),
	};
}

export interface ClaudeInitInfo {
	sessionId: string | null;
	model: string | null;
	slashCommands: string[];
	skills: string[];
}

export interface ClaudeTurnResult {
	isError: boolean;
	text: string | null;
}

export interface ClaudeStreamReduction {
	changedMessages: ClineTaskMessage[];
	init?: ClaudeInitInfo;
	turnResult?: ClaudeTurnResult;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readString(record: JsonRecord | null, key: string): string | null {
	const value = record?.[key];
	return typeof value === "string" ? value : null;
}

function readStringArray(record: JsonRecord, key: string): string[] {
	const value = record[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringifyToolResult(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				const record = asRecord(part);
				return record?.type === "text" ? (readString(record, "text") ?? "") : "";
			})
			.filter((text) => text.length > 0)
			.join("\n");
	}
	return content === undefined || content === null ? "" : JSON.stringify(content);
}

export function reduceClaudeStreamEvent(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: ClaudeStreamReducerState,
	rawEvent: unknown,
): ClaudeStreamReduction {
	const event = asRecord(rawEvent);
	const changedMessages: ClineTaskMessage[] = [];
	const reduction: ClaudeStreamReduction = { changedMessages };
	if (!event) {
		return reduction;
	}

	switch (event.type) {
		case "system": {
			if (event.subtype === "init") {
				reduction.init = {
					sessionId: readString(event, "session_id"),
					model: readString(event, "model"),
					slashCommands: readStringArray(event, "slash_commands"),
					skills: readStringArray(event, "skills"),
				};
			}
			return reduction;
		}
		case "stream_event":
			reduceStreamEvent(taskId, entry, state, asRecord(event.event), changedMessages);
			return reduction;
		case "assistant":
			reduceAssistantMessage(taskId, entry, state, asRecord(event.message), changedMessages);
			return reduction;
		case "user":
			reduceUserMessage(taskId, entry, state, asRecord(event.message), changedMessages);
			return reduction;
		case "result": {
			clearActiveTurnState(entry);
			state.currentStreamMessageId = null;
			reduction.turnResult = {
				isError:
					event.is_error === true || (typeof event.subtype === "string" && event.subtype.startsWith("error")),
				text: readString(event, "result"),
			};
			return reduction;
		}
		default:
			return reduction;
	}
}

function reduceStreamEvent(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: ClaudeStreamReducerState,
	streamEvent: JsonRecord | null,
	changedMessages: ClineTaskMessage[],
): void {
	if (!streamEvent) {
		return;
	}
	switch (streamEvent.type) {
		case "message_start": {
			state.currentStreamMessageId = readString(asRecord(streamEvent.message), "id");
			return;
		}
		case "content_block_start": {
			const block = asRecord(streamEvent.content_block);
			const blockType = readString(block, "type");
			if (blockType === "text") {
				entry.activeAssistantMessageId = null;
			} else if (blockType === "thinking") {
				entry.activeReasoningMessageId = null;
			} else if (blockType === "tool_use" && block) {
				changedMessages.push(startToolUse(taskId, entry, state, block));
			}
			return;
		}
		case "content_block_delta": {
			const delta = asRecord(streamEvent.delta);
			const text = readString(delta, "text");
			const thinking = readString(delta, "thinking");
			if (delta?.type === "text_delta" && text) {
				if (state.currentStreamMessageId) {
					state.streamedMessageIds.add(state.currentStreamMessageId);
				}
				changedMessages.push(appendAssistantChunk(entry, taskId, text));
			} else if (delta?.type === "thinking_delta" && thinking) {
				if (state.currentStreamMessageId) {
					state.streamedMessageIds.add(state.currentStreamMessageId);
				}
				changedMessages.push(appendReasoningChunk(entry, taskId, thinking));
			}
			return;
		}
		case "content_block_stop": {
			entry.activeAssistantMessageId = null;
			entry.activeReasoningMessageId = null;
			return;
		}
		case "message_stop": {
			state.currentStreamMessageId = null;
			return;
		}
		default:
			return;
	}
}

function startToolUse(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: ClaudeStreamReducerState,
	block: JsonRecord,
): ClineTaskMessage {
	const toolCallId = readString(block, "id");
	const toolName = readString(block, "name");
	if (toolCallId && toolName) {
		state.toolNameByToolCallId.set(toolCallId, toolName);
	}
	return startToolCallMessage(entry, taskId, {
		toolName,
		toolCallId,
		input: block.input && Object.keys(asRecord(block.input) ?? {}).length > 0 ? block.input : undefined,
	});
}

function reduceAssistantMessage(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: ClaudeStreamReducerState,
	message: JsonRecord | null,
	changedMessages: ClineTaskMessage[],
): void {
	const content = message?.content;
	if (!message || !Array.isArray(content)) {
		return;
	}
	const messageId = readString(message, "id");
	const alreadyStreamed = messageId !== null && state.streamedMessageIds.has(messageId);
	for (const rawBlock of content) {
		const block = asRecord(rawBlock);
		if (!block) {
			continue;
		}
		if (block.type === "text" && !alreadyStreamed) {
			const text = readString(block, "text");
			if (text) {
				changedMessages.push(createAssistantMessage(entry, taskId, text));
				entry.activeAssistantMessageId = null;
			}
		} else if (block.type === "tool_use") {
			const toolCallId = readString(block, "id");
			const existingMessageId = toolCallId ? (entry.toolMessageIdByToolCallId.get(toolCallId) ?? null) : null;
			if (!existingMessageId) {
				changedMessages.push(startToolUse(taskId, entry, state, block));
			} else if (toolCallId) {
				// Partial events open the tool card without input; the complete message carries it.
				entry.toolInputByToolCallId.set(toolCallId, block.input);
				const toolName = readString(block, "name");
				const refreshed = updateMessageInEntry(entry, existingMessageId, (current) => ({
					...current,
					content: buildToolCallContent({ toolName, input: block.input }),
				}));
				if (refreshed) {
					changedMessages.push(refreshed);
				}
			}
		}
	}
}

function reduceUserMessage(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: ClaudeStreamReducerState,
	message: JsonRecord | null,
	changedMessages: ClineTaskMessage[],
): void {
	const content = message?.content;
	if (!Array.isArray(content)) {
		return;
	}
	for (const rawBlock of content) {
		const block = asRecord(rawBlock);
		if (!block || block.type !== "tool_result") {
			continue;
		}
		const toolCallId = readString(block, "tool_use_id");
		const resultText = stringifyToolResult(block.content);
		const isError = block.is_error === true;
		changedMessages.push(
			finishToolCallMessage(entry, taskId, {
				toolName: toolCallId ? (state.toolNameByToolCallId.get(toolCallId) ?? null) : null,
				toolCallId,
				output: isError ? undefined : resultText,
				error: isError ? resultText || "Tool failed" : null,
				durationMs: null,
			}),
		);
	}
}

export function createClaudeUserMessage(taskId: string, text: string): ClineTaskMessage {
	return createMessage(taskId, "user", text);
}
