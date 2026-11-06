import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import {
	disablePasscode,
	generateInternalToken,
	generatePasscode,
	INTERNAL_TOKEN_ENV,
	resolveScopedHookToken,
	validateInternalToken,
} from "../../../src/security/passcode-manager";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createMockPtySession(pid: number) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
	};
}

function startTaskSession(manager: TerminalSessionManager, workspaceId: string | undefined) {
	return manager.startTaskSession({
		taskId: "task-1",
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: "/tmp/worktree",
		prompt: "",
		workspaceId,
	});
}

describe("TerminalSessionManager agent hook token", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		ptySessionSpawnMock.mockImplementation(() => createMockPtySession(4321));
	});

	afterEach(() => {
		disablePasscode();
		delete process.env[INTERNAL_TOKEN_ENV];
		generatePasscode();
	});

	it("replaces the inherited internal token with a workspace-scoped hook token in remote mode", async () => {
		generatePasscode();
		const master = generateInternalToken();
		const manager = new TerminalSessionManager();

		await startTaskSession(manager, "ws-1");

		const spawnRequest = ptySessionSpawnMock.mock.calls[0]?.[0] as { env: Record<string, string | undefined> };
		const agentToken = spawnRequest.env[INTERNAL_TOKEN_ENV];
		expect(agentToken).toBeDefined();
		expect(agentToken).not.toBe(master);
		expect(validateInternalToken(agentToken ?? "")).toBe(false);
		expect(resolveScopedHookToken(agentToken ?? "")).toEqual({ workspaceId: "ws-1" });
	});

	it("leaves the environment untouched when no internal token exists (local mode)", async () => {
		disablePasscode();
		delete process.env[INTERNAL_TOKEN_ENV];
		const manager = new TerminalSessionManager();

		await startTaskSession(manager, "ws-1");

		const spawnRequest = ptySessionSpawnMock.mock.calls[0]?.[0] as { env: Record<string, string | undefined> };
		expect(spawnRequest.env[INTERNAL_TOKEN_ENV]).toBeUndefined();
	});
});
