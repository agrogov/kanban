// Lightweight daily bar chart built from flex divs. Keeps the Statistics view dependency-free
// while staying crisp at any width; stacked mode totals one value per day, grouped mode compares
// series side by side.
import { useState } from "react";

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
	/** Compact formatter for y-axis ticks; defaults to the raw number. */
	formatAxis?: (value: number) => string;
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

// Round the axis maximum up to 1/2/5 x 10^n so ticks read 0, 1M, 2M instead of 2,103,442.
function niceMax(value: number): number {
	if (value <= 1) {
		return 1;
	}
	const magnitude = 10 ** Math.floor(Math.log10(value));
	const normalized = value / magnitude;
	const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return step * magnitude;
}

const GRID_LINES = 4;
// Keeps a non-zero kind visible next to a much larger one (cache reads dwarf input/output).
const MIN_SEGMENT_PX = 2;

export function StatsBarChart({
	labels,
	series,
	mode = "stack",
	height = 120,
	formatValue,
	formatAxis = String,
}: StatsBarChartProps) {
	const [hovered, setHovered] = useState<number | null>(null);
	const totals = labels.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
	const peak = mode === "stack" ? Math.max(...totals, 0) : Math.max(...series.flatMap((entry) => entry.values), 0);
	// Whole-number data (counts, tokens) must not get fractional ticks like 0.25 on tiny maxima.
	const allIntegers = series.every((entry) => entry.values.every(Number.isInteger));
	const max = allIntegers ? Math.max(niceMax(peak), GRID_LINES) : niceMax(peak);
	const labelStride = Math.max(1, Math.ceil(labels.length / 8));
	const hasData = totals.some((total) => total > 0);
	const hoveredIndex = hovered !== null && hovered < labels.length ? hovered : null;
	const hoveredLabel = hoveredIndex !== null ? labels[hoveredIndex] : undefined;
	const hoverFraction = hoveredIndex !== null ? (hoveredIndex + 0.5) / labels.length : 0;
	return (
		<div className="flex flex-col gap-1">
			<div className="flex gap-2">
				<div className="relative w-9 shrink-0 text-[10px] tabular-nums text-text-tertiary" style={{ height }}>
					{Array.from({ length: GRID_LINES + 1 }, (_, tick) => (
						<span
							key={tick}
							className="absolute right-0 -translate-y-1/2 leading-none"
							style={{ top: `${(1 - tick / GRID_LINES) * 100}%` }}
						>
							{formatAxis((max * tick) / GRID_LINES)}
						</span>
					))}
				</div>
				<div className="relative min-w-0 flex-1" style={{ height }}>
					{Array.from({ length: GRID_LINES + 1 }, (_, tick) => (
						<div
							key={tick}
							className={cn("absolute inset-x-0 h-px", tick === 0 ? "bg-border-bright" : "bg-border")}
							style={{ top: `${(1 - tick / GRID_LINES) * 100}%` }}
						/>
					))}
					<div className="absolute inset-0 flex items-end gap-px" onMouseLeave={() => setHovered(null)}>
						{labels.map((label, index) => (
							<div
								key={label}
								onMouseEnter={() => setHovered(index)}
								className={cn(
									"flex h-full min-w-[2px] flex-1 items-end justify-center",
									hoveredIndex === index ? "bg-surface-3/60" : undefined,
								)}
							>
								{mode === "stack" ? (
									<div className="flex w-full flex-col-reverse justify-start gap-px">
										{series.map((entry) => {
											const value = entry.values[index] ?? 0;
											if (value <= 0) {
												return null;
											}
											return (
												<div
													key={entry.key}
													className={cn("w-full", entry.colorClass)}
													style={{ height: `${(value / max) * height}px`, minHeight: MIN_SEGMENT_PX }}
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
						))}
					</div>
					{hoveredIndex !== null && hoveredLabel !== undefined ? (
						<div
							className="pointer-events-none absolute top-0 z-10 min-w-[150px] rounded-md border border-border-bright bg-surface-0 px-2.5 py-2 text-[11px] shadow-lg"
							style={{
								left: `${hoverFraction * 100}%`,
								transform: `translateX(${hoverFraction > 0.6 ? "calc(-100% - 8px)" : "8px"})`,
							}}
						>
							<div className="mb-1 font-medium text-text-primary">{tooltipLabel(hoveredLabel)}</div>
							{series.map((entry) => (
								<div key={entry.key} className="flex items-center gap-2 text-text-secondary">
									<span className={cn("h-2 w-2 shrink-0 rounded-sm", entry.colorClass)} />
									<span className="flex-1">{entry.label}</span>
									<span className="tabular-nums text-text-primary">
										{formatValue(entry.values[hoveredIndex] ?? 0, entry)}
									</span>
								</div>
							))}
						</div>
					) : null}
				</div>
			</div>
			<div className="flex justify-between pl-11 text-[10px] text-text-tertiary">
				{labels
					.filter((_, index) => index % labelStride === 0 || index === labels.length - 1)
					.map((label) => (
						<span key={label}>{axisLabel(label)}</span>
					))}
			</div>
			{hasData ? null : <div className="pt-1 text-center text-xs text-text-tertiary">No activity in this range</div>}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-11 pt-1">
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
