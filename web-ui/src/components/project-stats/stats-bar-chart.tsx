// Lightweight daily bar chart built from flex divs. Keeps the Statistics view dependency-free
// while staying crisp at any width; stacked mode totals one value per day, grouped mode compares
// series side by side.
import { cn } from "@/components/ui/cn";

export interface StatsChartSeries {
	key: string;
	label: string;
	/** Tailwind background class, e.g. "bg-status-blue". */
	colorClass: string;
	/** One value per label; same length as `labels`. */
	values: number[];
}

interface StatsBarChartProps {
	labels: string[];
	series: StatsChartSeries[];
	mode?: "stack" | "group";
	height?: number;
	formatValue: (value: number, series: StatsChartSeries) => string;
}

function axisLabel(dateKey: string): string {
	// Hourly buckets (the "Today" range) look like `YYYY-MM-DDTHH`.
	const hour = dateKey.split("T")[1];
	if (hour !== undefined) {
		return `${hour}:00`;
	}
	const [year, month, day] = dateKey.split("-").map(Number);
	if (!year || !month || !day) {
		return dateKey;
	}
	const date = new Date(year, month - 1, day);
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Full-precision label for hover titles: hourly keys read `YYYY-MM-DD HH:00`.
function tooltipLabel(key: string): string {
	return key.replace(/T(\d{2})$/, " $1:00");
}

export function StatsBarChart({ labels, series, mode = "stack", height = 120, formatValue }: StatsBarChartProps) {
	const totals = labels.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
	const max = Math.max(1, ...totals);
	const labelStride = Math.max(1, Math.ceil(labels.length / 8));
	const hasData = totals.some((total) => total > 0);
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-end gap-px overflow-x-auto pb-1" style={{ height }}>
				{labels.map((label, index) => {
					const dayTotal = totals[index] ?? 0;
					const dayTitle =
						dayTotal > 0
							? `${tooltipLabel(label)} · ${series
									.filter((entry) => (entry.values[index] ?? 0) > 0)
									.map((entry) => `${entry.label}: ${formatValue(entry.values[index] ?? 0, entry)}`)
									.join(" · ")}`
							: tooltipLabel(label);
					return (
						<div
							key={label}
							title={dayTitle}
							className="flex min-w-[8px] flex-1 items-end justify-center"
							style={{ height: "100%" }}
						>
							{mode === "stack" ? (
								<div className="flex w-full flex-col justify-end gap-px self-stretch">
									{series.map((entry) => {
										const value = entry.values[index] ?? 0;
										if (value <= 0) {
											return null;
										}
										return (
											<div
												key={entry.key}
												className={cn("w-full rounded-t-[1px]", entry.colorClass)}
												style={{ height: `${(value / max) * 100}%` }}
											/>
										);
									})}
								</div>
							) : (
								<div className="flex h-full w-full items-end justify-center gap-px">
									{series.map((entry) => {
										const value = entry.values[index] ?? 0;
										return (
											<div
												key={entry.key}
												className={cn("flex-1 rounded-t-[1px]", entry.colorClass)}
												style={{
													height: value > 0 ? `${(value / max) * 100}%` : 1,
													opacity: value > 0 ? 1 : 0.15,
												}}
											/>
										);
									})}
								</div>
							)}
						</div>
					);
				})}
			</div>
			<div className="flex justify-between text-[10px] text-text-tertiary">
				{labels
					.filter((_, index) => index % labelStride === 0 || index === labels.length - 1)
					.map((label) => (
						<span key={label}>{axisLabel(label)}</span>
					))}
			</div>
			{hasData ? null : <div className="pt-1 text-center text-xs text-text-tertiary">No activity in this range</div>}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
				{series.map((entry) => (
					<span key={entry.key} className="inline-flex items-center gap-1.5 text-[10px] text-text-secondary">
						<span className={cn("h-2 w-2 rounded-sm", entry.colorClass)} />
						{entry.label}
					</span>
				))}
			</div>
		</div>
	);
}
