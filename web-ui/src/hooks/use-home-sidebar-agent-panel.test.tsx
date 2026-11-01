import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { selectNewestTaskSessionSummary } from "@/hooks/home-sidebar-agent-panel-session-summary";
import type { RuntimeConfigResponse, RuntimeTaskSessionSummary } from "@/runtime/types";

const capturedChatPanelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@/components/detail-panels/cline-agent-chat-panel", () => ({
	ClineAgentChatPanel: (props: Record<string, unknown>) => {
		capturedChatPanelProps.current = props;
		return null;
	},
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: () => null,
}));

vi.mock("@/hooks/use-home-agent-session", () => ({
	useHomeAgentSession: () => ({ panelMode: "chat", taskId: "__home_agent__:workspace-1:agent" }),
}));

vi.mock("@/hooks/use-cline-chat-runtime-actions", () => ({
	useClineChatRuntimeActions: () => ({
		sendTaskChatMessage: async () => ({ ok: true }),
		loadTaskChatMessages: async () => null,
		cancelTaskChatTurn: async () => ({ ok: true }),
	}),
}));

vi.mock("@/hooks/use-is-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/terminal/theme-colors", () => ({
	useTerminalThemeColors: () => ({ surfaceRaised: "#000", textPrimary: "#fff" }),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { stopTaskSession: { mutate: async () => undefined } } }),
}));

function createSummary(state: RuntimeTaskSessionSummary["state"], updatedAt: number): RuntimeTaskSessionSummary {
	return {
		taskId: "__home_agent__:workspace:cline",
		state,
		agentId: "cline",
		workspacePath: "/tmp/repo",
		pid: null,
		startedAt: 1,
		updatedAt,
		lastOutputAt: updatedAt,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

describe("selectNewestTaskSessionSummary", () => {
	it("prefers the newer summary when the home sidebar session finishes after starting", () => {
		const localRunningSummary = createSummary("running", 10);
		const streamedIdleSummary = createSummary("idle", 20);

		expect(selectNewestTaskSessionSummary(localRunningSummary, streamedIdleSummary)).toEqual(streamedIdleSummary);
	});

	it("ignores a stale replayed summary when the live home sidebar session is newer", () => {
		const liveRunningSummary = createSummary("running", 20);
		const staleInterruptedSummary = createSummary("interrupted", 10);

		expect(selectNewestTaskSessionSummary(liveRunningSummary, staleInterruptedSummary)).toEqual(liveRunningSummary);
	});

	it("keeps the available summary when only one source has session state", () => {
		const localRunningSummary = createSummary("running", 10);

		expect(selectNewestTaskSessionSummary(localRunningSummary, null)).toEqual(localRunningSummary);
		expect(selectNewestTaskSessionSummary(null, localRunningSummary)).toEqual(localRunningSummary);
	});
});

describe("useHomeSidebarAgentPanel chat identity", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		capturedChatPanelProps.current = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	async function renderPanelFor(selectedAgentId: RuntimeConfigResponse["selectedAgentId"]): Promise<void> {
		const config = {
			selectedAgentId,
			effectiveCommand: "whatever",
			agents: [
				{ id: "cline", label: "Cline" },
				{ id: "claude-chat", label: "Claude Code (chat view)" },
				{ id: "codex-chat", label: "Codex (chat view)" },
				{ id: "pi-chat", label: "Pi (chat view)" },
			],
			clineProviderSettings: { providerId: "bedrock", modelId: "deepseek-v4.1-flash" },
		} as unknown as RuntimeConfigResponse;

		const { useHomeSidebarAgentPanel } = await import("@/hooks/use-home-sidebar-agent-panel");
		function Harness(): ReactElement | null {
			return useHomeSidebarAgentPanel({
				currentProjectId: "workspace-1",
				hasNoProjects: false,
				runtimeProjectConfig: config,
				clineSessionContextVersion: 0,
				taskSessions: {},
				workspaceGit: null,
				latestTaskChatMessage: null,
				taskChatMessagesByTaskId: {},
			});
		}
		await act(async () => {
			root.render(<Harness />);
		});
	}

	it("renders the Cline model picker only for the embedded Cline agent", async () => {
		await renderPanelFor("cline");
		expect(capturedChatPanelProps.current?.showModelPicker).toBe(true);
		expect(String(capturedChatPanelProps.current?.composerPlaceholder)).toContain("Ask Cline");

		await renderPanelFor("codex-chat");
		expect(capturedChatPanelProps.current?.showModelPicker).toBe(false);
		expect(String(capturedChatPanelProps.current?.composerPlaceholder)).toContain("Ask Codex");
		expect(String(capturedChatPanelProps.current?.composerPlaceholder)).not.toContain("Cline");
	});
});
