// Per-project Statistics view: AI usage (from the workspace usage ledger) plus board-flow
// metrics (from the current board). Opened from the top bar chart button.
import { RefreshCw, X } from "lucide-react";
import { useMemo } from "react";

import { StatsBarChart } from "@/components/project-stats/stats-bar-chart";
import type { UseProjectStatsDataResult } from "@/components/project-stats/use-project-stats-data";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeProjectStatsRangeDays, RuntimeProjectStatsUsageGroup } from "@/runtime/types";
import { formatCompactTokens, formatCostUsd, formatDurationMs, formatPercent } from "@/utils/stats-format";

const RANGE_OPTIONS: Array<{ days: RuntimeProjectStatsRangeDays; label: string }> = [
	{ days: 7, label: "7d" },
	{ days: 30, label: "30d" },
	{ days: 90, label: "90d" },
	{ days: 0, label: "All" },
];

function StatsCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div className="flex min-w-[110px] flex-1 flex-col gap-0.5 rounded-lg border border-border bg-surface-1 px-3 py-2.5">
			<span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
			<span className="text-lg font-medium text-text-primary tabular-nums leading-tight">{value}</span>
			{hint ? <span className="text-[10px] text-text-tertiary">{hint}</span> : null}
		</div>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{children}</h3>;
}

function BreakdownList({ title, groups }: { title: string; groups: RuntimeProjectStatsUsageGroup[] }) {
	const max = Math.max(1, ...groups.map((group) => group.totalTokens));
	return (
		<div className="flex flex-col gap-2">
			<SectionTitle>{title}</SectionTitle>
			{groups.length === 0 ? (
				<div className="rounded-lg border border-border bg-surface-1 px-3 py-4 text-xs text-text-tertiary">
					No usage recorded yet.
				</div>
			) : (
				<div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-2.5">
					{groups.map((group) => (
						<div key={group.key} className="flex items-center gap-2 text-xs">
							<span className="w-[130px] shrink-0 truncate text-text-primary" title={group.label}>
								{group.label}
							</span>
							<div className="h-2 min-w-4 flex-1 overflow-hidden rounded-sm bg-surface-3">
								<div
									className="h-full rounded-sm bg-accent"
									style={{ width: `${Math.max(2, (group.totalTokens / max) * 100)}%` }}
								/>
							</div>
							<span className="w-[52px] shrink-0 text-right tabular-nums text-text-secondary">
								{formatCompactTokens(group.totalTokens)}
							</span>
							<span className="w-[58px] shrink-0 text-right tabular-nums text-text-tertiary">
								{group.costUsd !== null ? formatCostUsd(group.costUsd) : ""}
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
								label="Total tokens"
								value={formatCompactTokens(usage?.totals.totalTokens ?? 0)}
								hint={`${usage?.totals.taskCount ?? 0} tasks`}
							/>
							<StatsCard
								label="Cost"
								value={usage?.totals.costUsd != null ? formatCostUsd(usage.totals.costUsd) : "—"}
								hint="only where reported"
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
							<SectionTitle>Tokens per day</SectionTitle>
							<div className="rounded-lg border border-border bg-surface-1 p-3">
								{usage && dailyLabels.length > 0 ? (
									<StatsBarChart
										labels={dailyLabels}
										height={140}
										formatValue={(value) => `${formatCompactTokens(value)} tok`}
										series={[
											{
												key: "input",
												label: "Input",
												colorClass: "bg-status-blue",
												values: usage.daily.map((day) => day.inputTokens),
											},
											{
												key: "cache-read",
												label: "Cache read",
												colorClass: "bg-status-green",
												values: usage.daily.map((day) => day.cacheReadTokens),
											},
											{
												key: "cache-write",
												label: "Cache write",
												colorClass: "bg-status-gold",
												values: usage.daily.map((day) => day.cacheWriteTokens),
											},
											{
												key: "output",
												label: "Output",
												colorClass: "bg-status-purple",
												values: usage.daily.map((day) => day.outputTokens),
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
							<StatsCard label="Completed" value={String(flow?.totals.completed ?? 0)} />
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
