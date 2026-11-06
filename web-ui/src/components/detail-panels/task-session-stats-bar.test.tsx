import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskSessionStatsBar } from "@/components/detail-panels/task-session-stats-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionUsage } from "@/runtime/types";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function usage(overrides: Partial<RuntimeTaskSessionUsage> = {}): RuntimeTaskSessionUsage {
	return {
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 900,
		cacheWriteTokens: 10,
		costUsd: null,
		turns: 4,
		steps: 12,
		contextTokens: 8000,
		contextWindowTokens: 200000,
		outputTokensPerSecond: 150,
		updatedAt: 0,
		...overrides,
	};
}

describe("TaskSessionStatsBar", () => {
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

	const render = (value: RuntimeTaskSessionUsage | null) => {
		act(() => {
			root.render(
				<TooltipProvider>
					<TaskSessionStatsBar usage={value} />
				</TooltipProvider>,
			);
		});
	};

	it("hides the row when the session has not reported usage yet", () => {
		render(null);
		expect(container.textContent).toBe("");
	});

	it("renders turns, steps, rate, tokens, cache hit, and context usage", () => {
		render(usage());
		expect(container.textContent).toContain("4");
		expect(container.textContent).toContain("12");
		expect(container.textContent).toContain("150 tok/s");
		expect(container.textContent).toContain("1.1k");
		expect(container.textContent).toContain("89%");
		expect(container.textContent).toContain("4%");
	});

	it("falls back to dashes for unavailable backend fields", () => {
		render(usage({ outputTokensPerSecond: null, contextTokens: null, contextWindowTokens: null }));
		expect(container.textContent).toContain("—");
	});
});
