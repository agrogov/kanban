import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseWorkspacePersistenceParams, useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import type { BoardData } from "@/types";

function createBoard(): BoardData {
	return { columns: [], dependencies: [] } as unknown as BoardData;
}

function HookHarness(props: UseWorkspacePersistenceParams): null {
	useWorkspacePersistence(props);
	return null;
}

describe("useWorkspacePersistence", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		container = document.createElement("div");
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.useRealTimers();
	});

	it("refetches on conflict without adopting the server revision first", async () => {
		const onWorkspaceRevisionChange = vi.fn();
		const onWorkspaceStateConflict = vi.fn();
		const refetchWorkspaceState = vi.fn().mockResolvedValue(undefined);
		const persistWorkspaceState = vi.fn().mockRejectedValue(new WorkspaceStateConflictError(9));

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard()}
					sessions={{}}
					currentProjectId="project-1"
					workspaceRevision={4}
					hydrationNonce={0}
					canPersistWorkspaceState
					isDocumentVisible
					isWorkspaceStateRefreshing={false}
					persistWorkspaceState={persistWorkspaceState}
					refetchWorkspaceState={refetchWorkspaceState}
					onWorkspaceRevisionChange={onWorkspaceRevisionChange}
					onWorkspaceStateConflict={onWorkspaceStateConflict}
				/>,
			);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});

		expect(persistWorkspaceState).toHaveBeenCalledTimes(1);
		expect(refetchWorkspaceState).toHaveBeenCalledTimes(1);
		expect(onWorkspaceStateConflict).toHaveBeenCalledWith({ workspaceId: "project-1", currentRevision: 9 });
		// Adopting revision 9 here would make the refetch skip hydrating the server board.
		expect(onWorkspaceRevisionChange).not.toHaveBeenCalled();
	});
});
