import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectStatsView } from "@/components/project-stats/project-stats-view";
import type { UseProjectStatsDataResult } from "@/components/project-stats/use-project-stats-data";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeProjectStatsResponse } from "@/runtime/types";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function statsResponse(overrides: Partial<RuntimeProjectStatsResponse> = {}): RuntimeProjectStatsResponse {
	return {
		ok: true,
		rangeDays: 7,
		from: 0,
		to: Date.now(),
		usage: {
			totals: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 100,
				cacheWriteTokens: 1,
				totalTokens: 116,
				costUsd: 0.12,
				turns: 3,
				steps: 7,
				taskCount: 2,
			},
			cacheHitPercent: 48,
			daily: [
				{
					date: "2026-11-05",
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 100,
					cacheWriteTokens: 1,
					totalTokens: 116,
					costUsd: 0.12,
					turns: 3,
				},
			],
			byAgent: [
				{
					key: "claude-chat",
					label: "claude-chat",
					totalTokens: 116,
					inputTokens: 10,
					outputTokens: 5,
					cacheReadTokens: 100,
					cacheWriteTokens: 1,
					costUsd: 0.12,
					turns: 3,
					taskCount: 2,
				},
			],
			byModel: [],
		},
		flow: {
			totals: {
				created: 4,
				completed: 2,
				wip: 1,
				backlog: 5,
				activeTasks: 1,
				medianCycleMs: 3600000,
				p90CycleMs: 7200000,
			},
			daily: [{ date: "2026-11-05", created: 4, completed: 2 }],
		},
		...overrides,
	};
}

function hookResult(data: RuntimeProjectStatsResponse | null): UseProjectStatsDataResult {
	return {
		rangeDays: 7,
		setRangeDays: vi.fn(),
		data,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(async () => data),
	};
}

describe("ProjectStatsView", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("renders usage and flow cards from the stats response", () => {
		act(() => {
			root.render(
				<TooltipProvider>
					<ProjectStatsView stats={hookResult(statsResponse())} onClose={vi.fn()} />
				</TooltipProvider>,
			);
		});
		const text = container.textContent ?? "";
		expect(text).toContain("Cache read");
		expect(text).toContain("100");
		expect(text).toContain("48%");
		expect(text).toContain("$0.120");
		expect(text).toContain("claude-chat");
		expect(text).toContain("1h");
		expect(text).not.toContain("Token history starts recording");
	});

	it("explains missing token history when the ledger is empty", () => {
		const empty = statsResponse();
		empty.usage = {
			...empty.usage,
			totals: { ...empty.usage.totals, totalTokens: 0 },
			daily: [],
			byAgent: [],
			byModel: [],
			cacheHitPercent: null,
		};
		act(() => {
			root.render(
				<TooltipProvider>
					<ProjectStatsView stats={hookResult(empty)} onClose={vi.fn()} />
				</TooltipProvider>,
			);
		});
		expect(container.textContent).toContain("Token history starts recording");
	});
});
