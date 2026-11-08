import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertTasksLanded } from "../../src/commands/task";
import type { RuntimeWorkspaceStateResponse } from "../../src/core/api-contract";
import { runGit } from "../../src/workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../../src/workspace/task-worktree";
import { createTempDir } from "../utilities/temp-dir";

const state = {
	board: {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [{ id: "task-1", title: "t", prompt: "p", baseRef: "main", createdAt: 0, updatedAt: 0 }],
			},
		],
		dependencies: [],
	},
	sessions: {},
} as unknown as RuntimeWorkspaceStateResponse;

describe("assertTasksLanded", () => {
	let cleanups: Array<() => void>;
	let originalHome: string | undefined;
	let repo: string;
	let worktree: string;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		const home = createTempDir("kanban-done-guard-home-");
		const project = createTempDir("kanban-done-guard-repo-");
		cleanups = [home.cleanup, project.cleanup];
		process.env.HOME = home.path;
		repo = project.path;
		await runGit(repo, ["init", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "t@example.com"]);
		await runGit(repo, ["config", "user.name", "T"]);
		writeFileSync(join(repo, "f.txt"), "base\n");
		await runGit(repo, ["add", "."]);
		await runGit(repo, ["commit", "-m", "base"]);
		worktree = (await getTaskWorkspacePathInfo({ cwd: repo, taskId: "task-1", baseRef: "main" })).path;
		mkdirSync(dirname(worktree), { recursive: true });
		const added = await runGit(repo, ["worktree", "add", "--detach", worktree, "main"]);
		expect(added.ok).toBe(true);
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const cleanup of cleanups) {
			cleanup();
		}
	});

	it("refuses a real commit that never reached the base branch", async () => {
		writeFileSync(join(worktree, "f.txt"), "task\n");
		await runGit(worktree, ["commit", "-am", "task work"]);

		await expect(assertTasksLanded(state, ["task-1"], repo)).rejects.toThrow(
			/Nothing was moved to done\.[\s\S]*1 commit\(s\) have not landed on main[\s\S]*--force/,
		);
	});

	it("refuses uncommitted work", async () => {
		writeFileSync(join(worktree, "f.txt"), "task\n");

		await expect(assertTasksLanded(state, ["task-1"], repo)).rejects.toThrow(/uncommitted changes/);
	});

	it("allows the move once the commit is on the base branch", async () => {
		writeFileSync(join(worktree, "f.txt"), "task\n");
		await runGit(worktree, ["commit", "-am", "task work"]);
		const sha = (await runGit(worktree, ["rev-parse", "HEAD"])).stdout.trim();
		const picked = await runGit(repo, ["cherry-pick", sha]);
		expect(picked.ok).toBe(true);

		await expect(assertTasksLanded(state, ["task-1"], repo)).resolves.toBeUndefined();
	});
});
