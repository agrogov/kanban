// Single owner of the workspace usage ledger (usage.jsonl) format and lifecycle:
// row shape, parsing, appends, size-bounded compaction, and reads. The ledger lives
// inside the workspace state directory so `removeWorkspaceStateFiles` deletes it with
// the rest of the project state.
//
// Compaction model: append-only rows grow without bound, so when the file crosses a
// byte threshold, per-session rows older than a recent-keep window are rolled up into
// aggregate rows grouped by (local day, taskId, agentId, modelId). Lossless invariants
// that keep statistics identical before and after a compaction:
// - every numeric field (tokens, cost, turns, steps) is summed, so totals match;
// - all rows in a group share one `dateKey(ts)`, so daily buckets match;
// - taskId/agentId/modelId are part of the group key, so per-agent/per-model breakdowns
//   and distinct task counts match;
// - rows inside the recent window are never folded, so the current run stays verbatim.
// Baseline semantics in usage-recorder are untouched by compaction: its run baselines
// are in-memory (seeded from live session summaries at track time) and it only ever
// appends deltas, so restart never re-counts persisted history and a changed
// startedAt still marks a new run counted whole.
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UsageLedgerRow {
	/** Epoch ms when the delta was observed. */
	ts: number;
	taskId: string;
	agentId: string | null;
	modelId: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number | null;
	turns: number;
	steps: number;
}

/** Ledger files larger than this are compacted when read (and periodically on append). */
export const USAGE_LEDGER_MAX_BYTES = 256 * 1024;
/** Rows newer than this window are always kept verbatim so the current run stays exact. */
export const USAGE_LEDGER_KEEP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** Background compaction is checked once every N appends per process. */
const USAGE_LEDGER_COMPACTION_CHECK_EVERY = 100;

export function dateKey(ts: number): string {
	const date = new Date(ts);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Parse JSONL text into ledger rows, skipping corrupt lines (a partial append must not blank the report). */
export function parseLedgerRows(raw: string): UsageLedgerRow[] {
	const rows: UsageLedgerRow[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as Partial<UsageLedgerRow>;
			if (
				typeof parsed.ts === "number" &&
				typeof parsed.taskId === "string" &&
				typeof parsed.inputTokens === "number" &&
				typeof parsed.outputTokens === "number"
			) {
				rows.push({
					ts: parsed.ts,
					taskId: parsed.taskId,
					agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
					modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheReadTokens: typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0,
					cacheWriteTokens: typeof parsed.cacheWriteTokens === "number" ? parsed.cacheWriteTokens : 0,
					costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : null,
					turns: typeof parsed.turns === "number" ? parsed.turns : 0,
					steps: typeof parsed.steps === "number" ? parsed.steps : 0,
				});
			}
		} catch {
			// Skip corrupt lines.
		}
	}
	return rows;
}

export function serializeLedgerRows(rows: UsageLedgerRow[]): string {
	let out = "";
	for (const row of rows) {
		out += `${JSON.stringify(row)}\n`;
	}
	return out;
}

interface CollapsedGroup {
	representative: UsageLedgerRow;
	costSum: number;
	hasCost: boolean;
}

/**
 * Fold rows older than the recent-keep window into one aggregate row per
 * (day, taskId, agentId, modelId). Returns a new row list sorted by ts; rows within
 * the window pass through untouched.
 */
export function compactLedgerRows(
	rows: UsageLedgerRow[],
	now: number,
	options: { keepRecentMs?: number } = {},
): UsageLedgerRow[] {
	const keepRecentMs = options.keepRecentMs ?? USAGE_LEDGER_KEEP_RECENT_MS;
	const cutoff = now - keepRecentMs;
	const recent: UsageLedgerRow[] = [];
	const groups = new Map<string, CollapsedGroup>();
	for (const row of rows) {
		if (row.ts >= cutoff) {
			recent.push(row);
			continue;
		}
		const key = `${dateKey(row.ts)}\u0000${row.taskId}\u0000${row.agentId ?? ""}\u0000${row.modelId ?? ""}`;
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				representative: { ...row },
				costSum: row.costUsd && row.costUsd > 0 ? row.costUsd : 0,
				hasCost: typeof row.costUsd === "number" && row.costUsd > 0,
			});
			continue;
		}
		const acc = existing.representative;
		acc.ts = Math.min(acc.ts, row.ts);
		acc.inputTokens += row.inputTokens;
		acc.outputTokens += row.outputTokens;
		acc.cacheReadTokens += row.cacheReadTokens;
		acc.cacheWriteTokens += row.cacheWriteTokens;
		acc.turns += row.turns;
		acc.steps += row.steps;
		if (typeof row.costUsd === "number" && row.costUsd > 0) {
			existing.costSum += row.costUsd;
			existing.hasCost = true;
		}
	}
	const collapsed: UsageLedgerRow[] = [];
	for (const group of groups.values()) {
		group.representative.costUsd = group.hasCost ? group.costSum : null;
		collapsed.push(group.representative);
	}
	return [...collapsed, ...recent].sort((left, right) => left.ts - right.ts);
}

// Per-path operation queue: appends and compactions for one ledger file are serialized
// in-process, and compaction rewrites go through a temp file + atomic rename so a reader
// never observes a half-written ledger.
const operationQueues = new Map<string, Promise<void>>();
const appendCounts = new Map<string, number>();

function enqueueLedgerOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const previous = operationQueues.get(path) ?? Promise.resolve();
	const run = previous.then(operation, operation);
	operationQueues.set(
		path,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

async function readFileOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function rewriteLedgerFile(path: string, rows: UsageLedgerRow[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(tempPath, serializeLedgerRows(rows), "utf8");
	await rename(tempPath, path);
}

/**
 * Compact the ledger file when it exceeds `maxBytes`: fold rows older than the
 * recent-keep window and atomically rewrite. Returns true when the file was rewritten.
 */
export async function compactUsageLedgerFile(
	path: string,
	options: { now?: number; maxBytes?: number; keepRecentMs?: number } = {},
): Promise<boolean> {
	const now = options.now ?? Date.now();
	const maxBytes = options.maxBytes ?? USAGE_LEDGER_MAX_BYTES;
	return enqueueLedgerOperation(path, async () => {
		const raw = await readFileOrNull(path);
		if (raw === null || Buffer.byteLength(raw) <= maxBytes) {
			return false;
		}
		const rows = parseLedgerRows(raw);
		const compacted = compactLedgerRows(rows, now, { keepRecentMs: options.keepRecentMs });
		if (compacted.length >= rows.length) {
			// Nothing foldable (all rows are recent): leave the file alone.
			return false;
		}
		await rewriteLedgerFile(path, compacted);
		return true;
	});
}

/**
 * Read ledger rows, lazily compacting the file first when it is oversized. Reads are
 * safe against a concurrent compaction rewrite (atomic rename), and compaction is a
 * lossless fold, so totals are identical either way.
 */
export async function readUsageLedgerRows(
	path: string,
	options: { now?: number; maxBytes?: number } = {},
): Promise<UsageLedgerRow[]> {
	const raw = await readFileOrNull(path);
	if (raw === null) {
		return [];
	}
	const maxBytes = options.maxBytes ?? USAGE_LEDGER_MAX_BYTES;
	if (Buffer.byteLength(raw) > maxBytes) {
		const compacted = await compactUsageLedgerFile(path, { ...options, maxBytes });
		if (compacted) {
			return parseLedgerRows((await readFileOrNull(path)) ?? "");
		}
	}
	return parseLedgerRows(raw);
}

/** Append one delta row; every N appends a background size check may compact the file. */
export async function appendUsageLedgerRow(path: string, row: UsageLedgerRow): Promise<void> {
	await enqueueLedgerOperation(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
	});
	const seen = (appendCounts.get(path) ?? 0) + 1;
	if (seen >= USAGE_LEDGER_COMPACTION_CHECK_EVERY) {
		appendCounts.set(path, 0);
		void compactUsageLedgerFile(path).catch(() => {
			// Compaction failures must never affect session recording.
		});
	} else {
		appendCounts.set(path, seen);
	}
}
