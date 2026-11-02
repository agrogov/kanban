import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	listChatAgentModels,
	listPiConfiguredModels,
	parseClaudeSettingsModel,
	parseCodexConfigModel,
} from "../../../src/core/chat-agent-models";

const dirs: string[] = [];

async function makeHome(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "chat-agent-models-"));
	dirs.push(dir);
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = join(dir, relativePath);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, contents);
	}
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pi models", () => {
	it("lists the models declared in models.json, qualified by provider", () => {
		const options = listPiConfiguredModels({
			providers: {
				strata: { models: [{ id: "qwen-flash" }] },
				commandcode: { models: ["deepseek/deepseek-v4.1-flash"] },
			},
		});
		expect(options.map((option) => option.id)).toEqual([
			"commandcode/deepseek/deepseek-v4.1-flash",
			"strata/qwen-flash",
		]);
	});

	it("reads ~/.pi/agent/models.json without any network call", async () => {
		const home = await makeHome({});
		const piDir = await makeHome({
			"models.json": JSON.stringify({ providers: { strata: { models: [{ id: "qwen-flash" }] } } }),
		});
		const response = await listChatAgentModels("pi-chat", { piAgentDir: piDir, homeDir: home });
		expect(response.source).toBe("config");
		expect(response.models.map((model) => model.id)).toEqual(["strata/qwen-flash"]);
	});

	it("reports an empty pi configuration", async () => {
		const empty = await makeHome({});
		const response = await listChatAgentModels("pi-chat", { piAgentDir: empty, homeDir: empty });
		expect(response.source).toBe("none");
		expect(response.error).toMatch(/models\.json/);
	});
});

describe("claude/codex models", () => {
	it("reuses the model configured for each CLI", async () => {
		const home = await makeHome({
			".codex/config.toml": 'model = "gpt-5-codex"\n',
			".claude/settings.json": JSON.stringify({ model: "claude-sonnet-5-5" }),
		});
		expect(parseCodexConfigModel('model = "gpt-5-codex"\n')).toBe("gpt-5-codex");
		expect(parseClaudeSettingsModel(JSON.stringify({ model: "claude-sonnet-5-5" }))).toBe("claude-sonnet-5-5");

		const codex = await listChatAgentModels("codex-chat", { piAgentDir: home, homeDir: home });
		expect(codex.models.map((model) => model.id)).toEqual(["gpt-5-codex"]);

		const claude = await listChatAgentModels("claude-chat", { piAgentDir: home, homeDir: home });
		expect(claude.models.map((model) => model.id)).toEqual(["claude-sonnet-5-5"]);
	});

	it("reports a missing CLI config instead of inventing models", async () => {
		const home = await makeHome({});
		const codex = await listChatAgentModels("codex-chat", { piAgentDir: home, homeDir: home });
		expect(codex.source).toBe("none");
		expect(codex.error).toMatch(/config\.toml/);
	});
});
