// Ledger compaction tests. The core invariant, asserted from several angles:
// statistics computed from the ledger are identical before and after compaction
// (totals, day buckets, agent/model groups, task counts), and current-run rows
// inside the recent window survive verbatim.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	appendUsageLedgerRow,
	compactLedgerRows,
	compactUsageLedgerFile,
	parseLedgerRows,
	readUsageLedgerRows,
	serializeLedgerRows,
	type UsageLedgerRow,
} from "../../../src/server/usage-ledger";

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
const SMALL_MAX_BYTES = 1024;

function row(overrides: Partial<UsageLedgerRow>): UsageLedgerRow {
	return {
		ts: NOW - 10 * DAY,
		taskId: "t1",
		agentId: "codex-chat",
		modelId: "gpt-5",
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 400,
		cacheWriteTokens: 10,
		costUsd: null,
		turns: 1,
		steps: 2,
		...overrides,
	};
}

interface Totals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	turns: number;
	steps: number;
	taskIds: string[];
}

function sumTotals(rows: UsageLedgerRow[]): Totals {
	const totals: Totals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
		turns: 0,
		steps: 0,
		taskIds: [],
	};
	const seen = new Set<string>();
	for (const r of rows) {
		totals.inputTokens += r.inputTokens;
		totals.outputTokens += r.outputTokens;
		totals.cacheReadTokens += r.cacheReadTokens;
		totals.cacheWriteTokens += r.cacheWriteTokens;
		if (r.costUsd != null && r.costUsd > 0) {
			totals.costUsd += r.costUsd;
		}
		totals.turns += r.turns;
		totals.steps += r.steps;
		if (!seen.has(r.taskId)) {
			seen.add(r.taskId);
			totals.taskIds.push(r.taskId);
		}
	}
	totals.taskIds.sort();
	return totals;
}

function dayKeyLocal(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Day-bucketed totals: the exact aggregation loadProjectStats performs, so equality here
// proves compaction cannot change the statistics view.
function dayBuckets(rows: UsageLedgerRow[]): Record<string, Totals> {
	const byDate = new Map<string, UsageLedgerRow[]>();
	for (const r of rows) {
		const key = dayKeyLocal(r.ts);
		const list = byDate.get(key) ?? [];
		list.push(r);
		byDate.set(key, list);
	}
	return Object.fromEntries(Array.from(byDate.entries()).map(([key, list]) => [key, sumTotals(list)]));
}

function groupTotals(rows: UsageLedgerRow[], pick: (r: UsageLedgerRow) => string | null): Record<string, Totals> {
	const byKey = new Map<string, UsageLedgerRow[]>();
	for (const r of rows) {
		const key = pick(r) ?? "unknown";
		const list = byKey.get(key) ?? [];
		list.push(r);
		byKey.set(key, list);
	}
	return Object.fromEntries(Array.from(byKey.entries()).map(([key, list]) => [key, sumTotals(list)]));
}

// Integer costs only: folding reorders additions, and float rounding would make the
// before/after equality assertions flaky for the wrong reason.
// A task keeps one agent/model across turns (like a real session), so each
// (day, task, agent, model) group holds several per-turn rows to fold.
function buildHistory(): UsageLedgerRow[] {
	const rows: UsageLedgerRow[] = [];
	for (let day = 0; day < 20; day++) {
		for (let task = 0; task < 4; task++) {
			for (let turn = 0; turn < 3; turn++) {
				rows.push(
					row({
						ts: NOW - (day + 1) * DAY - turn * 30 * 60 * 1000,
						taskId: `t${task}`,
						agentId: ["codex-chat", "claude-chat", "pi-chat"][task % 3],
						modelId: task % 2 === 0 ? "gpt-5" : "sonnet",
						inputTokens: 100 + day + task + turn,
						outputTokens: 50 + day,
						cacheReadTokens: 400 + task,
						cacheWriteTokens: 10 + turn,
						costUsd: day % 3 === 0 ? day + turn + 1 : null,
						turns: 1,
						steps: 2 + (day % 2),
					}),
				);
			}
		}
	}
	return rows;
}

const tempDirs: string[] = [];

async function makeLedgerPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "usage-ledger-"));
	tempDirs.push(dir);
	return join(dir, "usage.jsonl");
}

afterAll(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("compactLedgerRows", () => {
	it("preserves totals, day buckets, agent/model groups and task counts exactly", () => {
		const rows = buildHistory();
		const compacted = compactLedgerRows(rows, NOW);

		expect(compacted.length).toBeLessThan(rows.length);
		expect(sumTotals(compacted)).toEqual(sumTotals(rows));
		expect(dayBuckets(compacted)).toEqual(dayBuckets(rows));
		expect(groupTotals(compacted, (r) => r.agentId)).toEqual(groupTotals(rows, (r) => r.agentId));
		expect(groupTotals(compacted, (r) => r.modelId)).toEqual(groupTotals(rows, (r) => r.modelId));
	});

	it("keeps rows inside the recent window verbatim", () => {
		const rows = [
			row({ ts: NOW - 30 * DAY, taskId: "old" }),
			row({ ts: NOW - 2 * DAY, taskId: "recent-a" }),
			row({ ts: NOW - DAY, taskId: "recent-b" }),
		];
		const compacted = compactLedgerRows(rows, NOW);
		const recent = compacted.filter((r) => r.taskId.startsWith("recent"));
		expect(recent.map((r) => r.ts).sort()).toEqual([NOW - 2 * DAY, NOW - DAY]);
		expect(compacted.filter((r) => r.taskId === "old")).toHaveLength(1);
	});

	it("folds many same-day same-session deltas into one row on the original day", () => {
		const dayStart = new Date(NOW - 30 * DAY);
		dayStart.setHours(0, 0, 0, 0);
		const rows = Array.from({ length: 50 }, (_, i) =>
			row({
				ts: dayStart.getTime() + i * 60 * 1000,
				taskId: "t1",
				agentId: "pi-chat",
				modelId: "qwen",
				inputTokens: 10,
				outputTokens: 5,
				costUsd: 2,
			}),
		);
		const compacted = compactLedgerRows(rows, NOW);
		expect(compacted).toHaveLength(1);
		expect(compacted[0].inputTokens).toBe(500);
		expect(compacted[0].outputTokens).toBe(250);
		expect(compacted[0].costUsd).toBe(100);
		// Representative ts stays inside the same local day so buckets do not shift.
		expect(dayKeyLocal(compacted[0].ts)).toBe(dayKeyLocal(rows[0].ts));
	});

	it("folds null-cost rows with positive-cost rows into a positive total", () => {
		const rows = [row({ ts: NOW - 20 * DAY, costUsd: null }), row({ ts: NOW - 20 * DAY - 1000, costUsd: 5 })];
		const compacted = compactLedgerRows(rows, NOW);
		expect(compacted).toHaveLength(1);
		expect(compacted[0].costUsd).toBe(5);
	});
});

describe("compactUsageLedgerFile", () => {
	it("rewrites an oversized ledger losslessly and is idempotent", async () => {
		const path = await makeLedgerPath();
		const rows = buildHistory();
		rows.push(row({ ts: NOW - 60 * 1000, taskId: "live" }));
		await writeFile(path, serializeLedgerRows(rows), "utf8");
		const sizeBefore = (await stat(path)).size;
		expect(sizeBefore).toBeGreaterThan(SMALL_MAX_BYTES);

		expect(await compactUsageLedgerFile(path, { now: NOW, maxBytes: SMALL_MAX_BYTES })).toBe(true);
		const after = parseLedgerRows(await readFile(path, "utf8"));
		expect((await stat(path)).size).toBeLessThan(sizeBefore);

		// Totals identical before and after compaction; the live-run tail survives verbatim.
		expect(sumTotals(after)).toEqual(sumTotals(rows));
		expect(dayBuckets(after)).toEqual(dayBuckets(rows));
		expect(after.filter((r) => r.taskId === "live")).toHaveLength(1);

		// Idempotent: nothing left to fold, file untouched.
		expect(await compactUsageLedgerFile(path, { now: NOW, maxBytes: SMALL_MAX_BYTES })).toBe(false);
		expect(parseLedgerRows(await readFile(path, "utf8"))).toEqual(after);
	});

	it("leaves a file under the size bound untouched", async () => {
		const path = await makeLedgerPath();
		const rows = [row({ ts: NOW - 30 * DAY }), row({ ts: NOW - 30 * DAY - 1000 })];
		await writeFile(path, serializeLedgerRows(rows), "utf8");
		expect(await compactUsageLedgerFile(path, { now: NOW, maxBytes: SMALL_MAX_BYTES })).toBe(false);
		expect(parseLedgerRows(await readFile(path, "utf8"))).toEqual(rows);
	});

	it("does not fold current-run rows even when oversized", async () => {
		const path = await makeLedgerPath();
		const rows = Array.from({ length: 400 }, (_, i) => row({ ts: NOW - i * 1000, taskId: `t${i}` }));
		await writeFile(path, serializeLedgerRows(rows), "utf8");
		expect((await stat(path)).size).toBeGreaterThan(SMALL_MAX_BYTES);
		expect(await compactUsageLedgerFile(path, { now: NOW, maxBytes: SMALL_MAX_BYTES })).toBe(false);
		expect(parseLedgerRows(await readFile(path, "utf8"))).toHaveLength(rows.length);
	});
});

describe("readUsageLedgerRows", () => {
	it("compacts oversized ledgers on read and returns identical totals", async () => {
		const path = await makeLedgerPath();
		const rows = buildHistory();
		await writeFile(path, serializeLedgerRows(rows), "utf8");
		const read = await readUsageLedgerRows(path, { now: NOW, maxBytes: SMALL_MAX_BYTES });
		expect(read.length).toBeLessThan(rows.length);
		expect(sumTotals(read)).toEqual(sumTotals(rows));
		// The rewrite landed on disk, not just in the return value.
		expect((await stat(path)).size).toBeLessThan(Buffer.byteLength(serializeLedgerRows(rows)));
		expect(parseLedgerRows(await readFile(path, "utf8"))).toEqual(read);
	});

	it("returns empty for a missing ledger without throwing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "usage-ledger-missing-"));
		tempDirs.push(dir);
		expect(await readUsageLedgerRows(join(dir, "nope.jsonl"))).toEqual([]);
	});
});

describe("appendUsageLedgerRow", () => {
	it("creates parent directories and appends parseable JSONL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "usage-ledger-append-"));
		tempDirs.push(dir);
		const path = join(dir, "nested", "usage.jsonl");
		await appendUsageLedgerRow(path, row({ ts: NOW, taskId: "a" }));
		await appendUsageLedgerRow(path, row({ ts: NOW + 1, taskId: "b" }));
		const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(parseLedgerRows(lines.join("\n")).map((r) => r.taskId)).toEqual(["a", "b"]);
	});

	it("serializes concurrent appends and an interleaved compaction without losing rows", async () => {
		const path = await makeLedgerPath();
		const seed = Array.from({ length: 300 }, (_, i) =>
			row({ ts: NOW - 30 * DAY - i * 1000, taskId: `s${i % 3}`, inputTokens: 100 + i }),
		);
		await writeFile(path, serializeLedgerRows(seed), "utf8");

		const live = Array.from({ length: 20 }, (_, i) => row({ ts: NOW - i, taskId: `live${i}`, inputTokens: i + 1 }));
		await Promise.all([
			...live.map((r) => appendUsageLedgerRow(path, r)),
			compactUsageLedgerFile(path, { now: NOW, maxBytes: SMALL_MAX_BYTES }),
		]);

		const after = parseLedgerRows(await readFile(path, "utf8"));
		// No append is lost: current-run rows survive verbatim inside the recent window.
		expect(after.filter((r) => r.taskId.startsWith("live"))).toHaveLength(20);
		expect(sumTotals(after)).toEqual(sumTotals([...seed, ...live]));
	});
});
