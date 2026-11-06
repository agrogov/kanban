// Per-project Statistics view: AI usage (from the workspace usage ledger) plus board-flow
// metrics (from the current board). Opened from the top bar chart button.
import { Info, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";

import { StatsBarChart } from "@/components/project-stats/stats-bar-chart";
import type { UseProjectStatsDataResult } from "@/components/project-stats/use-project-stats-data";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	RuntimeProjectStatsRangeDays,
	RuntimeProjectStatsUsageDay,
	RuntimeProjectStatsUsageGroup,
} from "@/runtime/types";
import { formatCompactTokens, formatCostUsd, formatDurationMs, formatPercent } from "@/utils/stats-format";

const RANGE_OPTIONS: Array<{ days: RuntimeProjectStatsRangeDays; label: string }> = [
	{ days: 1, label: "Today" },
	{ days: 7, label: "7d" },
	{ days: 30, label: "30d" },
	{ days: 90, label: "90d" },
	{ days: 0, label: "All" },
];

function StatsCard({
	label,
	value,
	hint,
	tooltip,
}: {
	label: string;
	value: string;
	hint?: string;
	tooltip?: React.ReactNode;
}) {
	return (
		<Tooltip content={tooltip}>
			<div
				className={cn(
					"flex min-w-[110px] flex-1 flex-col gap-0.5 rounded-lg border border-border bg-surface-1 px-3 py-2.5",
					tooltip ? "cursor-help" : undefined,
				)}
			>
				<span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-tertiary">
					{label}
					{tooltip ? <Info size={10} aria-hidden className="shrink-0" /> : null}
				</span>
				<span className="text-lg font-medium text-text-primary tabular-nums leading-tight">{value}</span>
				{hint ? <span className="text-[10px] text-text-tertiary">{hint}</span> : null}
			</div>
		</Tooltip>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{children}</h3>;
}

const TOKEN_KINDS = [
	{ key: "input", label: "Input", colorClass: "bg-status-blue" },
	{ key: "cacheRead", label: "Cache read", colorClass: "bg-status-green" },
	{ key: "cacheWrite", label: "Cache write", colorClass: "bg-status-gold" },
	{ key: "output", label: "Output", colorClass: "bg-status-purple" },
] as const;

type TokenKind = (typeof TOKEN_KINDS)[number]["key"];

function groupTokens(group: RuntimeProjectStatsUsageGroup, kind: TokenKind): number {
	switch (kind) {
		case "input":
			return group.inputTokens;
		case "cacheRead":
			return group.cacheReadTokens;
		case "cacheWrite":
			return group.cacheWriteTokens;
		case "output":
			return group.outputTokens;
	}
}

function dayTokens(day: RuntimeProjectStatsUsageDay | undefined, kind: TokenKind): number {
	if (!day) {
		return 0;
	}
	switch (kind) {
		case "input":
			return day.inputTokens;
		case "cacheRead":
			return day.cacheReadTokens;
		case "cacheWrite":
			return day.cacheWriteTokens;
		case "output":
			return day.outputTokens;
	}
}

// Token kinds are never summed into one number: cache reads dwarf everything else and mean
// something different from fresh input or generated output.
function BreakdownList({ title, groups }: { title: string; groups: RuntimeProjectStatsUsageGroup[] }) {
	return (
		<div className="flex flex-col gap-2">
			<SectionTitle>{title}</SectionTitle>
			{groups.length === 0 ? (
				<div className="rounded-lg border border-border bg-surface-1 px-3 py-4 text-xs text-text-tertiary">
					No usage recorded yet.
				</div>
			) : (
				<div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-2.5">
					<div className="flex items-center gap-2 text-[10px] text-text-tertiary">
						<span className="min-w-0 flex-1" />
						{TOKEN_KINDS.map((kind) => (
							<span key={kind.key} className="w-[52px] shrink-0 text-right">
								{kind.label}
							</span>
						))}
						<span className="w-[58px] shrink-0 text-right">Cost</span>
					</div>
					{groups.map((group) => (
						<div key={group.key} className="flex items-center gap-2 text-xs">
							<span className="min-w-0 flex-1 truncate text-text-primary" title={group.label}>
								{group.label}
							</span>
							{TOKEN_KINDS.map((kind) => (
								<span key={kind.key} className="w-[52px] shrink-0 text-right tabular-nums text-text-secondary">
									{formatCompactTokens(groupTokens(group, kind.key))}
								</span>
							))}
							<span className="w-[58px] shrink-0 text-right tabular-nums text-text-tertiary">
								{group.costUsd !== null ? formatCostUsd(group.costUsd) : "—"}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function ProjectStatsView({
	stats,
	onClose,
}: {
	stats: UseProjectStatsDataResult;
	onClose: () => void;
}): React.ReactElement {
	const { data, isLoading, isError, error, rangeDays, setRangeDays, refetch } = stats;
	const usage = data?.usage ?? null;
	const flow = data?.flow ?? null;
	const dailyLabels = useMemo(() => (data ? data.flow.daily.map((day) => day.date) : []), [data]);
	// Usage and flow build their own daily buckets; pair the usage series to the chart labels by
	// date key instead of assuming the two arrays stay index-aligned.
	const usageDailyByDate = useMemo(() => {
		const map = new Map<string, RuntimeProjectStatsUsageDay>();
		if (usage) {
			for (const day of usage.daily) {
				map.set(day.date, day);
			}
		}
		return map;
	}, [usage]);
	const [tokenKindKey, setTokenKindKey] = useState<TokenKind>("input");
	const tokenKind = TOKEN_KINDS.find((kind) => kind.key === tokenKindKey) ?? TOKEN_KINDS[0];
	const bucketUnit = rangeDays === 1 ? "hour" : "day";
	const hasUsageData = Boolean(usage && usage.totals.totalTokens > 0);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
			<div className="flex items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
				<span className="text-sm font-medium text-text-primary">Statistics</span>
				<div className="ml-2 flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
					{RANGE_OPTIONS.map((option) => (
						<button
							key={option.label}
							type="button"
							onClick={() => setRangeDays(option.days)}
							className={cn(
								"rounded px-2 py-0.5 text-xs tabular-nums",
								rangeDays === option.days
									? "bg-surface-4 text-text-primary"
									: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
							)}
						>
							{option.label}
						</button>
					))}
				</div>
				<div className="ml-auto flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						icon={<RefreshCw size={14} />}
						onClick={() => void refetch()}
						aria-label="Refresh statistics"
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<X size={16} />}
						onClick={onClose}
						aria-label="Close statistics"
					/>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{isLoading && !data ? (
					<div className="flex h-full items-center justify-center">
						<Spinner size={26} />
					</div>
				) : isError && !data ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-text-secondary">
						<span className="text-sm">{error?.message ?? "Could not load statistics."}</span>
						<Button size="sm" onClick={() => void refetch()}>
							Retry
						</Button>
					</div>
				) : data ? (
					<div className="mx-auto flex w-full max-w-[900px] flex-col gap-4 px-4 py-4">
						{!hasUsageData ? (
							<div className="rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-xs text-text-secondary">
								Token history starts recording from this build onward, so usage trends fill in as agents run.
								Board-flow stats below already cover existing tasks.
							</div>
						) : null}
						<div className="flex flex-wrap gap-2">
							<StatsCard
								label="Input"
								value={formatCompactTokens(usage?.totals.inputTokens ?? 0)}
								hint="tokens"
							/>
							<StatsCard
								label="Cache read"
								value={formatCompactTokens(usage?.totals.cacheReadTokens ?? 0)}
								hint="tokens"
							/>
							<StatsCard
								label="Cache write"
								value={formatCompactTokens(usage?.totals.cacheWriteTokens ?? 0)}
								hint="tokens"
							/>
							<StatsCard
								label="Output"
								value={formatCompactTokens(usage?.totals.outputTokens ?? 0)}
								hint="tokens"
							/>
							<StatsCard
								label="Cost"
								value={usage?.totals.costUsd != null ? formatCostUsd(usage.totals.costUsd) : "—"}
								hint="not reported by every agent"
							/>
							<StatsCard
								label="Cache hit"
								value={usage?.cacheHitPercent != null ? formatPercent(usage.cacheHitPercent) : "—"}
								hint="of prompt tokens"
							/>
							<StatsCard label="Turns" value={String(usage?.totals.turns ?? 0)} />
							<StatsCard label="Tool steps" value={String(usage?.totals.steps ?? 0)} />
						</div>
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-3">
								<SectionTitle>Tokens per {bucketUnit}</SectionTitle>
								<div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
									{TOKEN_KINDS.map((kind) => (
										<button
											key={kind.key}
											type="button"
											onClick={() => setTokenKindKey(kind.key)}
											className={cn(
												"rounded px-2 py-0.5 text-xs",
												tokenKind.key === kind.key
													? "bg-surface-4 text-text-primary"
													: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
											)}
										>
											{kind.label}
										</button>
									))}
								</div>
							</div>
							<div className="rounded-lg border border-border bg-surface-1 p-3">
								{usage && dailyLabels.length > 0 ? (
									<StatsBarChart
										labels={dailyLabels}
										height={140}
										formatValue={(value) => `${formatCompactTokens(value)} tok`}
										series={[
											{
												key: tokenKind.key,
												label: tokenKind.label,
												colorClass: tokenKind.colorClass,
												values: dailyLabels.map((date) =>
													dayTokens(usageDailyByDate.get(date), tokenKind.key),
												),
											},
										]}
									/>
								) : (
									<div className="py-6 text-center text-xs text-text-tertiary">No token data yet.</div>
								)}
							</div>
						</div>
						<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
							<BreakdownList title="By agent" groups={usage?.byAgent ?? []} />
							<BreakdownList title="By model" groups={usage?.byModel ?? []} />
						</div>
						<div className="h-px bg-border" />
						<div className="flex flex-wrap gap-2">
							<StatsCard label="Created" value={String(flow?.totals.created ?? 0)} />
							<StatsCard
								label="Completed"
								value={String(flow?.totals.completed ?? 0)}
								tooltip="Counts every card in the Done/trash column, including cards discarded before done. Cycle time is measured from card creation to its last update (updatedAt)."
							/>
							<StatsCard
								label="In flight"
								value={String(flow?.totals.wip ?? 0)}
								hint={`${flow?.totals.activeTasks ?? 0} running`}
							/>
							<StatsCard label="Backlog" value={String(flow?.totals.backlog ?? 0)} />
							<StatsCard
								label="Median cycle"
								value={flow?.totals.medianCycleMs != null ? formatDurationMs(flow.totals.medianCycleMs) : "—"}
							/>
							<StatsCard
								label="p90 cycle"
								value={flow?.totals.p90CycleMs != null ? formatDurationMs(flow.totals.p90CycleMs) : "—"}
							/>
						</div>
						<div className="flex flex-col gap-2">
							<SectionTitle>Created vs completed</SectionTitle>
							<div className="rounded-lg border border-border bg-surface-1 p-3">
								{flow && dailyLabels.length > 0 ? (
									<StatsBarChart
										labels={dailyLabels}
										mode="group"
										height={120}
										formatValue={(value) => String(value)}
										series={[
											{
												key: "created",
												label: "Created",
												colorClass: "bg-status-orange",
												values: flow.daily.map((day) => day.created),
											},
											{
												key: "completed",
												label: "Completed",
												colorClass: "bg-status-green",
												values: flow.daily.map((day) => day.completed),
											},
										]}
									/>
								) : null}
							</div>
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}
