import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureAgencProjectTrusted, resolveAgencProjectRoot } from "../../../src/terminal/agenc-project-trust";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-agenc-trust-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ensureAgencProjectTrusted", () => {
	it("records the worktree root in trusted-projects.json once, preserving other fields", async () => {
		const agencHome = makeTempDir();
		const worktree = makeTempDir();
		writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n");
		mkdirSync(join(worktree, "src"));
		writeFileSync(
			join(agencHome, "trusted-projects.json"),
			JSON.stringify({ version: 1, trustedProjects: [{ path: "/other", trustedAt: "t0" }], keep: true }),
		);

		const root = await ensureAgencProjectTrusted(join(worktree, "src"), { AGENC_HOME: agencHome });
		await ensureAgencProjectTrusted(worktree, { AGENC_HOME: agencHome });

		expect(root).toBe(worktree);
		const storePath = join(agencHome, "trusted-projects.json");
		const stored = JSON.parse(readFileSync(storePath, "utf8")) as {
			version: number;
			keep: boolean;
			trustedProjects: Array<{ path: string; trustedAt: string }>;
		};
		expect(stored.version).toBe(1);
		expect(stored.keep).toBe(true);
		expect(stored.trustedProjects.map((entry) => entry.path)).toEqual(["/other", worktree]);
		expect(statSync(storePath).mode & 0o777).toBe(0o600);
	});

	it("creates the store when missing and falls back to cwd without a .git marker", async () => {
		const agencHome = join(makeTempDir(), "nested-home");
		const dir = makeTempDir();

		await ensureAgencProjectTrusted(dir, { AGENC_HOME: agencHome });

		const stored = JSON.parse(readFileSync(join(agencHome, "trusted-projects.json"), "utf8")) as {
			trustedProjects: Array<{ path: string }>;
		};
		expect(stored.trustedProjects.map((entry) => entry.path)).toEqual([resolveAgencProjectRoot(dir)]);
	});
});
