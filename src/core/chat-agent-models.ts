import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CLAUDE_CHAT_EFFORT_LEVELS } from "../claude-chat/claude-chat-task-session-service";
import { CODEX_CHAT_EFFORT_LEVELS } from "../codex-chat/codex-chat-task-session-service";
import { PI_CHAT_THINKING_LEVELS, readPiDefaultModel } from "../pi-chat/pi-chat-task-session-service";
import type { RuntimeAgentId } from "./api-contract";

// Model catalogs for the native chat agents.
//
// Deliberately config-driven, not HTTP-driven:
// * pi-chat lists the models the user put in ~/.pi/agent/models.json — that file
//   is the source of truth for a Pi install, including custom providers.
// * claude-chat / codex-chat have no enumerable catalog, so the model configured
//   for the CLI itself is reused (the same one the user picked there).

export interface ChatAgentModelOption {
	id: string;
	label: string;
	providerId: string | null;
}

export interface ChatAgentModelsResponse {
	agentId: RuntimeAgentId | null;
	source: "config" | "none";
	models: ChatAgentModelOption[];
	/**
	 * Reasoning-effort vocabulary the agent's own runtime accepts, in picker order.
	 * Sourced from each backend's SDK-derived list so the UI cannot drift from it.
	 */
	effortLevels: string[];
	defaultModelId?: string | null;
	error?: string;
}

interface PiModelsFile {
	providers?: Record<string, { models?: unknown[] }>;
}

function readModelId(entry: unknown): string | null {
	if (typeof entry === "string") {
		return entry.trim() || null;
	}
	if (entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string") {
		return entry.id.trim() || null;
	}
	return null;
}

/** Models declared in ~/.pi/agent/models.json, grouped by provider. */
export function listPiConfiguredModels(file: PiModelsFile | null): ChatAgentModelOption[] {
	const options: ChatAgentModelOption[] = [];
	for (const [providerId, config] of Object.entries(file?.providers ?? {})) {
		for (const entry of config?.models ?? []) {
			const id = readModelId(entry);
			if (id) {
				options.push({ id: `${providerId}/${id}`, label: id, providerId });
			}
		}
	}
	return options.sort((left, right) => left.id.localeCompare(right.id));
}

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** `model = "gpt-5-codex"` from ~/.codex/config.toml (TOML, parsed by pattern). */
export function parseCodexConfigModel(contents: string | null): string | null {
	if (!contents) {
		return null;
	}
	const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(contents);
	return match?.[1]?.trim() || null;
}

/** `model` from ~/.claude/settings.json. */
export function parseClaudeSettingsModel(contents: string | null): string | null {
	if (!contents) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(contents);
		if (parsed && typeof parsed === "object" && "model" in parsed && typeof parsed.model === "string") {
			return parsed.model.trim() || null;
		}
	} catch {
		return null;
	}
	return null;
}

/** Effort levels an agent accepts, straight from the backend that validates them at launch. */
export function listChatAgentEffortLevels(agentId: RuntimeAgentId | null | undefined): string[] {
	switch (agentId) {
		case "pi-chat":
			return [...PI_CHAT_THINKING_LEVELS];
		case "codex-chat":
			return [...CODEX_CHAT_EFFORT_LEVELS];
		case "claude-chat":
			return [...CLAUDE_CHAT_EFFORT_LEVELS];
		default:
			return [];
	}
}

/** Enumerate an agent's selectable models from its own configuration. */
export async function listChatAgentModels(
	agentId: RuntimeAgentId | null | undefined,
	options: { piAgentDir: string; homeDir?: string },
): Promise<ChatAgentModelsResponse> {
	const effortLevels = listChatAgentEffortLevels(agentId);
	const resolved = await resolveChatAgentModels(agentId, {
		piAgentDir: options.piAgentDir,
		homeDir: options.homeDir ?? homedir(),
	});
	return { ...resolved, effortLevels };
}

async function resolveChatAgentModels(
	agentId: RuntimeAgentId | null | undefined,
	options: { piAgentDir: string; homeDir: string },
): Promise<Omit<ChatAgentModelsResponse, "effortLevels">> {
	const home = options.homeDir;

	if (agentId === "pi-chat") {
		const raw = await readTextFile(join(options.piAgentDir, "models.json"));
		const file = raw ? (JSON.parse(raw) as PiModelsFile) : null;
		const models = listPiConfiguredModels(file);
		// Same convention as `pi --model`: "provider/id" or a bare model id.
		const piDefault = await readPiDefaultModel(options.piAgentDir);
		const defaultModelId = models.find((model) => model.id === piDefault || model.label === piDefault)?.id ?? null;
		return models.length > 0
			? { agentId, source: "config", models, defaultModelId }
			: {
					agentId,
					source: "none",
					models: [],
					error: "No models in ~/.pi/agent/models.json.",
				};
	}

	if (agentId === "codex-chat") {
		const model = parseCodexConfigModel(await readTextFile(join(home, ".codex", "config.toml")));
		return model
			? { agentId, source: "config", models: [{ id: model, label: model, providerId: "openai" }] }
			: { agentId, source: "none", models: [], error: "No model configured in ~/.codex/config.toml." };
	}

	if (agentId === "claude-chat") {
		const model = parseClaudeSettingsModel(await readTextFile(join(home, ".claude", "settings.json")));
		return model
			? { agentId, source: "config", models: [{ id: model, label: model, providerId: "anthropic" }] }
			: { agentId, source: "none", models: [], error: "No model configured in ~/.claude/settings.json." };
	}

	return { agentId: agentId ?? null, source: "none", models: [] };
}
