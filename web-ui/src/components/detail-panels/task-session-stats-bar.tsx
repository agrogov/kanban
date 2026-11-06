// DeepSeek-style live stats row rendered under the chat composer. Values come from the
// session summary's cumulative usage; anything a backend cannot report renders as an em dash.
import { Clock3, Coins, Cpu, Layers, MessagesSquare, Table2 } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionUsage } from "@/runtime/types";
import { formatCompactTokens, formatPercent, formatTokenRate } from "@/utils/stats-format";

interface StatItem {
	key: string;
	tooltip: string;
	icon: React.ReactNode;
	label: string;
}

function buildStatItems(usage: RuntimeTaskSessionUsage): StatItem[] {
	const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	const cacheHit = promptTokens > 0 ? (usage.cacheReadTokens / promptTokens) * 100 : null;
	const contextUsed =
		usage.contextTokens !== null && usage.contextWindowTokens !== null
			? Math.min(100, (usage.contextTokens / usage.contextWindowTokens) * 100)
			: null;
	const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	return [
		{
			key: "turns",
			tooltip: "Prompts sent this session",
			icon: <MessagesSquare size={11} />,
			label: String(usage.turns),
		},
		{
			key: "steps",
			tooltip: "Tool calls this session",
			icon: <Layers size={11} />,
			label: String(usage.steps),
		},
		{
			key: "rate",
			tooltip: "Output speed of the latest turn",
			icon: <Clock3 size={11} />,
			label: usage.outputTokensPerSecond !== null ? formatTokenRate(usage.outputTokensPerSecond) : "—",
		},
		{
			key: "tokens",
			tooltip: "Total tokens this session (in + out + cache)",
			icon: <Cpu size={11} />,
			label: formatCompactTokens(totalTokens),
		},
		{
			key: "cache",
			tooltip: "Share of prompt tokens served from cache",
			icon: <Coins size={11} />,
			label: cacheHit !== null ? formatPercent(cacheHit) : "—",
		},
		{
			key: "context",
			tooltip:
				contextUsed !== null
					? `Context used: ${formatCompactTokens(usage.contextTokens ?? 0)} / ${formatCompactTokens(usage.contextWindowTokens ?? 0)} tokens`
					: "Context window size not reported by this agent",
			icon: <Table2 size={11} />,
			label:
				contextUsed !== null
					? formatPercent(contextUsed)
					: usage.contextTokens !== null
						? formatCompactTokens(usage.contextTokens)
						: "—",
		},
	];
}

export function TaskSessionStatsBar({ usage }: { usage: RuntimeTaskSessionUsage | null | undefined }) {
	if (!usage) {
		return null;
	}
	const items = buildStatItems(usage);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1.5 text-micro text-text-tertiary select-none">
			{items.map((item) => (
				<Tooltip key={item.key} content={item.tooltip}>
					<span className="inline-flex items-center gap-1 tabular-nums">
						{item.icon}
						{item.label}
					</span>
				</Tooltip>
			))}
		</div>
	);
}
