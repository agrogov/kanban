import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readPiDefaultModel } from "../pi-chat/pi-chat-task-session-service";
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

/** Enumerate an agent's selectable models from its own configuration. */
export async function listChatAgentModels(
	agentId: RuntimeAgentId | null | undefined,
	options: { piAgentDir: string; homeDir?: string },
): Promise<ChatAgentModelsResponse> {
	const home = options.homeDir ?? homedir();

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
