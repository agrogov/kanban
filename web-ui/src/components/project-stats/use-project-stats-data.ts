import { useCallback, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectStatsRangeDays, RuntimeProjectStatsResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseProjectStatsDataResult {
	rangeDays: RuntimeProjectStatsRangeDays;
	setRangeDays: (rangeDays: RuntimeProjectStatsRangeDays) => void;
	data: RuntimeProjectStatsResponse | null;
	isLoading: boolean;
	isError: boolean;
	error: Error | null;
	refetch: () => Promise<RuntimeProjectStatsResponse | null>;
}

export function useProjectStatsData(options: {
	workspaceId: string | null;
	enabled: boolean;
}): UseProjectStatsDataResult {
	const { workspaceId, enabled } = options;
	const [rangeDays, setRangeDays] = useState<RuntimeProjectStatsRangeDays>(30);
	const queryFn = useCallback(async (): Promise<RuntimeProjectStatsResponse> => {
		const client = getRuntimeTrpcClient(workspaceId);
		return await client.workspace.getProjectStats.query({ rangeDays });
	}, [workspaceId, rangeDays]);
	const query = useTrpcQuery<RuntimeProjectStatsResponse>({
		enabled: enabled && Boolean(workspaceId),
		queryFn,
		retainDataOnError: true,
	});
	return {
		rangeDays,
		setRangeDays,
		data: query.data,
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
	};
}
