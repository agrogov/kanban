import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countUnlandedCommits } from "../../../src/server/auto-review-reconciler";
import { runGit } from "../../../src/workspace/git-utils";

describe("countUnlandedCommits", () => {
	let repo: string;
	beforeEach(async () => {
		repo = await mkdtemp(join(tmpdir(), "unlanded-"));
		await runGit(repo, ["init", "-b", "main"]);
		await runGit(repo, ["config", "user.email", "t@example.com"]);
		await runGit(repo, ["config", "user.name", "T"]);
		await writeFile(join(repo, "f.txt"), "base\n");
		await runGit(repo, ["add", "."]);
		await runGit(repo, ["commit", "-m", "base"]);
		await runGit(repo, ["checkout", "--detach"]);
		await writeFile(join(repo, "f.txt"), "task\n");
		await runGit(repo, ["commit", "-am", "task work"]);
	});
	afterEach(async () => {
		await rm(repo, { recursive: true, force: true });
	});

	it("counts a commit that is missing from the base", async () => {
		expect(await countUnlandedCommits(repo, "main")).toBe(1);
	});

	it("reports an unknown count instead of zero when git cannot compare against the base", async () => {
		// Unknown must stay distinct from "nothing left to land", which completes the card.
		expect(await countUnlandedCommits(repo, "no-such-base-ref")).toBeUndefined();
	});

	it("treats a hand-resolved cherry-pick as landed even though its patch id differs", async () => {
		const sha = (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
		await runGit(repo, ["checkout", "main"]);
		await runGit(repo, ["cherry-pick", "--no-commit", sha]);
		await writeFile(join(repo, "f.txt"), "task\nconflict resolution extra\n");
		await runGit(repo, ["add", "."]);
		const message = (await runGit(repo, ["log", "-1", "--format=%s", sha])).stdout.trim();
		const authorDate = (await runGit(repo, ["log", "-1", "--format=%aI", sha])).stdout.trim();
		await runGit(repo, ["commit", "-m", message, `--date=${authorDate}`]);
		await runGit(repo, ["checkout", sha]);

		expect(await countUnlandedCommits(repo, "main")).toBe(0);
	});
});
