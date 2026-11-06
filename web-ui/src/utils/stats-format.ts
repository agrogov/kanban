export function formatCompactTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "0";
	}
	if (value < 1000) {
		return String(Math.round(value));
	}
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
	}
	const millions = value / 1_000_000;
	return `${millions.toFixed(millions >= 100 ? 0 : 1).replace(/\.0$/, "")}M`;
}

export function formatPercent(value: number): string {
	if (!Number.isFinite(value)) {
		return "—";
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatTokenRate(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
		return "—";
	}
	const value = tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : Math.round(tokensPerSecond * 10) / 10;
	return `${String(value).replace(/\.0$/, "")} tok/s`;
}

export function formatCostUsd(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return "$0.00";
	}
	if (value < 1) {
		return `$${value.toFixed(3)}`;
	}
	return `$${value.toFixed(2)}`;
}

export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "—";
	}
	const minutes = ms / 60_000;
	if (minutes < 1) {
		return "<1m";
	}
	if (minutes < 60) {
		return `${Math.round(minutes)}m`;
	}
	const hours = minutes / 60;
	if (hours < 24) {
		return `${hours.toFixed(1).replace(/\.0$/, "")}h`;
	}
	const days = hours / 24;
	return `${days.toFixed(1).replace(/\.0$/, "")}d`;
}
