export const ANSI_RE = /\x1B\[[0-9;]*m/g;

function isCombining(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f)
	);
}

function isWide(codePoint: number): boolean {
	return (
		codePoint >= 0x1100 &&
		(
			codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
			(codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd)
		)
	);
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function visibleWidth(text: string): number {
	let width = 0;
	for (const char of stripAnsi(text)) {
		const codePoint = char.codePointAt(0) ?? 0;
		if (isCombining(codePoint)) continue;
		width += isWide(codePoint) ? 2 : 1;
	}
	return width;
}

export function truncatePlain(text: string, width: number, ellipsis = "..."): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (visibleWidth(ellipsis) >= width) {
		let out = "";
		for (const char of ellipsis) {
			if (visibleWidth(out + char) > width) break;
			out += char;
		}
		return out;
	}
	let out = "";
	for (const char of text) {
		if (visibleWidth(out + char) + visibleWidth(ellipsis) > width) break;
		out += char;
	}
	return out + ellipsis;
}

export function replaceHomePrefix(cwd: string, home?: string): string {
	if (!home) return cwd;
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function buildPwdLine(cwd: string, branch?: string | null): string {
	return branch ? `${cwd} (${branch})` : cwd;
}

export function injectLabelOnBorder(
	baseLine: string,
	labelText: string,
	width: number,
): { prefix: string; label: string } {
	const plainBase = stripAnsi(baseLine);
	const label = ` ${labelText} `;
	if (width <= 0) return { prefix: "", label: "" };
	if (visibleWidth(label) >= width) {
		return { prefix: "", label: truncatePlain(label, width, "") };
	}
	const prefixWidth = width - visibleWidth(label);
	let prefix = truncatePlain(plainBase, prefixWidth, "");
	while (visibleWidth(prefix) < prefixWidth && plainBase.endsWith("─")) {
		prefix += "─";
	}
	return { prefix, label };
}

export function buildRightAlignedLine(text: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncatePlain(text, width, "");
	const pad = Math.max(0, width - visibleWidth(truncated));
	return " ".repeat(pad) + truncated;
}

export interface FooterStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextPercent?: number | null;
	contextWindow?: number;
	autoCompactEnabled: boolean;
	modelName: string;
	providerName?: string;
	providerCount: number;
	thinkingLevel?: string;
	reasoning: boolean;
	usingSubscription: boolean;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function buildFooterStatsLeft(stats: FooterStats): string {
	const parts: string[] = [];
	if (stats.input) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	if (stats.cost || stats.usingSubscription) {
		parts.push(`$${stats.cost.toFixed(3)}${stats.usingSubscription ? " (sub)" : ""}`);
	}
	const auto = stats.autoCompactEnabled ? " (auto)" : "";
	const window = formatTokens(stats.contextWindow ?? 0);
	if (typeof stats.contextPercent === "number") {
		parts.push(`${stats.contextPercent.toFixed(1)}%/${window}${auto}`);
	} else {
		parts.push(`?/${window}${auto}`);
	}
	return parts.join(" ");
}

export function buildFooterRight(stats: FooterStats): string {
	let right = stats.modelName;
	if (stats.reasoning) {
		right = `${right} • ${stats.thinkingLevel || "off"}`;
	}
	if (stats.providerCount > 1 && stats.providerName) {
		right = `(${stats.providerName}) ${right}`;
	}
	return right;
}

export function alignFooterLine(left: string, right: string, width: number): string {
	const minPadding = 2;
	const leftText = truncatePlain(left, width, "");
	const leftWidth = visibleWidth(leftText);
	const rightWidth = visibleWidth(right);
	if (leftWidth + minPadding + rightWidth <= width) {
		return leftText + " ".repeat(width - leftWidth - rightWidth) + right;
	}
	const availableRight = Math.max(0, width - leftWidth - minPadding);
	if (availableRight === 0) return leftText;
	const truncatedRight = truncatePlain(right, availableRight, "");
	const truncatedRightWidth = visibleWidth(truncatedRight);
	return leftText + " ".repeat(Math.max(minPadding, width - leftWidth - truncatedRightWidth)) + truncatedRight;
}
