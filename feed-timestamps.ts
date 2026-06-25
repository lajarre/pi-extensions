import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OSC133_ZONE_END_FINAL = `${OSC133_ZONE_END}${OSC133_ZONE_FINAL}`;
const ANSI_RE =
	/\x1b(?:\][^\u0007]*(?:\u0007|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BACKGROUND_ANSI_RE = /\x1b\[(?:48;[25];[0-9;]*|4[0-7]|10[0-7])m/;
const BACKGROUND_RESET = "\x1b[49m";
const COMPONENT_TIMESTAMP_PROPERTY = "__piFeedTimestamp__";

type ThemeModule = {
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
	};
};

type RuledTimestampLineOptions = {
	rule: string;
	timestamp?: string;
	marker?: string;
	ruleColor: string;
	markerColor?: string;
	timestampColor?: string;
};

type UserMessageComponentLike = {
	prototype: {
		render(width: number): string[];
		timestamp?: string | null;
	};
};

type TimestampedRenderableComponentClass = {
	prototype: {
		render(width: number): string[];
	};
};

type ToolExecutionComponentLike = {
	prototype: {
		render(width: number): string[];
		toolCallId?: string;
	};
};

type AssistantMessageComponentLike = {
	prototype: {
		render(width: number): string[];
		lastMessage?: { timestamp?: number };
	};
};

type InteractiveModeLike = {
	prototype: {
		addMessageToChat(
			message: { role?: string; timestamp?: number },
			options?: { populateHistory?: boolean },
		): void;
		chatContainer?: {
			children?: unknown[];
		};
	};
};

type TimestampedUserMessage = {
	timestamp?: string | null;
	[COMPONENT_TIMESTAMP_PROPERTY]?: string;
};

type PatchState = {
	patched: boolean;
	pkgRoot?: string;
	toolTimestamps: Map<string, string>;
};

declare global {
	// eslint-disable-next-line no-var
	var __piFeedTimestampsState__: PatchState | undefined;
}

let state = globalThis.__piFeedTimestampsState__;
if (!state) {
	state = {
		patched: false,
		toolTimestamps: new Map(),
	};
	globalThis.__piFeedTimestampsState__ = state;
}
state.toolTimestamps ??= new Map();

function getPkgRoot(): string {
	if (state.pkgRoot) return state.pkgRoot;

	const pkgEntry = fileURLToPath(
		import.meta.resolve("@mariozechner/pi-coding-agent"),
	);
	state.pkgRoot = path.dirname(path.dirname(pkgEntry));
	return state.pkgRoot;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function formatTimestamp(
	timestamp?: number | string,
): string | undefined {
	const value =
		typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	if (value === undefined || !Number.isFinite(value)) return undefined;

	const date = new Date(value);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
		date.getDate(),
	)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
		date.getSeconds(),
	)}`;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function isBrefSyntheticLine(line: string): boolean {
	return stripAnsi(line).trimStart().startsWith("↳");
}

function splitZoneStart(line: string): {
	prefix: string;
	content: string;
} {
	return line.startsWith(OSC133_ZONE_START)
		? {
				prefix: OSC133_ZONE_START,
				content: line.slice(OSC133_ZONE_START.length),
			}
		: { prefix: "", content: line };
}

function splitZoneEndFinal(line: string): {
	prefix: string;
	content: string;
} {
	return line.startsWith(OSC133_ZONE_END_FINAL)
		? {
				prefix: OSC133_ZONE_END_FINAL,
				content: line.slice(OSC133_ZONE_END_FINAL.length),
			}
		: { prefix: "", content: line };
}

function isBlankLine(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

function isBackgroundLine(line: string): boolean {
	return BACKGROUND_ANSI_RE.test(line);
}

function isBorderOnlyLine(line: string): boolean {
	return /^[─━-]+$/.test(stripAnsi(line).trim());
}

function renderRuledTimestampLine(
	width: number,
	theme: ThemeModule["theme"],
	options: RuledTimestampLineOptions,
): string {
	if (width <= 0) return "";
	const timestamp = options.timestamp ?? "";
	const timestampText = timestamp ? ` ${timestamp}` : "";
	if (visibleWidth(timestampText) >= width) {
		return theme.fg(
			options.timestampColor ?? "dim",
			timestampText.slice(-width),
		);
	}

	let markerText = options.marker ? ` ${options.marker} ` : "";
	if (
		markerText &&
		visibleWidth(markerText) + visibleWidth(timestampText) >= width
	) {
		markerText = "";
	}

	const fillWidth = Math.max(
		0,
		width - visibleWidth(markerText) - visibleWidth(timestampText),
	);
	const leftFillWidth = markerText ? Math.min(1, fillWidth) : 0;
	const rightFillWidth = fillWidth - leftFillWidth;
	return (
		theme.fg(options.ruleColor, options.rule.repeat(leftFillWidth)) +
		(markerText
			? theme.fg(options.markerColor ?? "accent", markerText)
			: "") +
		theme.fg(options.ruleColor, options.rule.repeat(rightFillWidth)) +
		(timestampText
			? theme.fg(options.timestampColor ?? "dim", timestampText)
			: "")
	);
}

function renderDashedTimestampLine(
	width: number,
	timestamp: string,
	theme: ThemeModule["theme"],
	dash = "╌",
	marker?: string,
): string {
	return renderRuledTimestampLine(width, theme, {
		rule: dash,
		timestamp,
		marker,
		ruleColor: "borderMuted",
	});
}

function renderDashedRuleLine(
	width: number,
	theme: ThemeModule["theme"],
	dash = "╌",
	marker?: string,
): string {
	return renderRuledTimestampLine(width, theme, {
		rule: dash,
		marker,
		ruleColor: "borderMuted",
	});
}

function renderTimestampInBackgroundLine(
	line: string,
	width: number,
	timestamp: string,
	theme: ThemeModule["theme"],
): string | undefined {
	const bg = line.match(BACKGROUND_ANSI_RE)?.[0];
	if (!bg) return undefined;

	const text =
		timestamp.length >= width
			? timestamp.slice(-width)
			: ` ${timestamp}`;
	const content =
		text.length >= width
			? theme.fg("dim", text.slice(-width))
			: `${" ".repeat(width - text.length)}${theme.fg("dim", text)}`;
	return `${bg}${content}${BACKGROUND_RESET}`;
}

function renderUserTopBorder(
	width: number,
	timestamp: string | undefined,
	theme: ThemeModule["theme"],
): string {
	if (width <= 0) return "";
	const rawTimestamp = timestamp
		? timestamp.length > width
			? timestamp.slice(-width)
			: timestamp
		: "";
	const timestampText = rawTimestamp ? ` ${rawTimestamp}` : "";
	if (timestampText.length >= width) {
		return theme.bg(
			"userMessageBg",
			theme.fg("dim", timestampText.slice(-width)),
		);
	}

	return theme.bg(
		"userMessageBg",
		renderRuledTimestampLine(width, theme, {
			rule: "─",
			timestamp: rawTimestamp,
			marker: "💬",
			ruleColor: "borderAccent",
		}),
	);
}

function renderUserBottomBorder(
	width: number,
	theme: ThemeModule["theme"],
): string {
	return theme.bg(
		"userMessageBg",
		theme.fg("borderAccent", "─".repeat(Math.max(0, width))),
	);
}

function replaceUserMessageBorders(
	lines: string[],
	width: number,
	timestamp: string | undefined,
	theme: ThemeModule["theme"],
): string[] {
	if (lines.length < 2) return lines;

	const startPrefix = lines[0]?.startsWith(OSC133_ZONE_START)
		? OSC133_ZONE_START
		: "";
	const endPrefix = lines[lines.length - 1]?.startsWith(
		OSC133_ZONE_END_FINAL,
	)
		? OSC133_ZONE_END_FINAL
		: "";

	const next = [...lines];
	next[0] = `${startPrefix}${renderUserTopBorder(width, timestamp, theme)}`;
	next[next.length - 1] =
		`${endPrefix}${renderUserBottomBorder(width, theme)}`;
	return next;
}

function addTimestampToBlock(
	lines: string[],
	width: number,
	timestamp: string | undefined,
	theme: ThemeModule["theme"],
	options: {
		marker?: string;
		trimBlankAfterTimestamp?: boolean;
		trailingRuleMarker?: string;
	} = {},
): string[] {
	if (!timestamp || lines.length === 0) return lines;
	const finalize = (next: string[], timestampIndex: number) => {
		let finalized = options.trimBlankAfterTimestamp
			? removeBlankLinesAfter(next, timestampIndex)
			: next;
		if (options.trailingRuleMarker) {
			finalized = addTrailingRuleLine(
				finalized,
				width,
				theme,
				options.trailingRuleMarker,
			);
		}
		return finalized;
	};

	const candidateIndexes = lines.flatMap((line, index) =>
		isBrefSyntheticLine(line) ? [] : [index],
	);
	if (candidateIndexes.length === 0) return lines;

	const leadingChromeIndexes: number[] = [];
	for (const index of candidateIndexes) {
		const line = lines[index] ?? "";
		if (!isBlankLine(line) && !isBorderOnlyLine(line)) break;
		leadingChromeIndexes.push(index);
	}

	const backgroundBlankIndex = leadingChromeIndexes.find((index) => {
		const line = lines[index] ?? "";
		return isBlankLine(line) && isBackgroundLine(line);
	});
	if (backgroundBlankIndex !== undefined) {
		const line = lines[backgroundBlankIndex] ?? "";
		const { prefix, content } = splitZoneStart(line);
		const rendered = renderTimestampInBackgroundLine(
			content,
			width,
			timestamp,
			theme,
		);
		if (rendered) {
			const next = [...lines];
			next[backgroundBlankIndex] = `${prefix}${rendered}`;
			return finalize(next, backgroundBlankIndex);
		}
	}

	const borderIndex = leadingChromeIndexes.find((index) =>
		isBorderOnlyLine(lines[index] ?? ""),
	);
	if (borderIndex !== undefined) {
		const line = lines[borderIndex] ?? "";
		const { prefix, content } = splitZoneStart(line);
		const dash = stripAnsi(content).trim().at(0) ?? "╌";
		const next = [...lines];
		next[borderIndex] = `${prefix}${renderDashedTimestampLine(
			width,
			timestamp,
			theme,
			dash,
			options.marker,
		)}`;
		return finalize(next, borderIndex);
	}

	const blankIndex = leadingChromeIndexes.find((index) =>
		isBlankLine(lines[index] ?? ""),
	);
	if (blankIndex !== undefined) {
		const line = lines[blankIndex] ?? "";
		const { prefix } = splitZoneStart(line);
		const next = [...lines];
		next[blankIndex] = `${prefix}${renderDashedTimestampLine(
			width,
			timestamp,
			theme,
			"╌",
			options.marker,
		)}`;
		return finalize(next, blankIndex);
	}

	const targetIndex = candidateIndexes[0] ?? 0;
	const line = lines[targetIndex] ?? "";
	const { prefix } = splitZoneStart(line);
	const timestampLine = `${prefix}${renderDashedTimestampLine(
		width,
		timestamp,
		theme,
		"╌",
		options.marker,
	)}`;
	const next = [...lines];
	next.splice(targetIndex, 0, timestampLine);
	return finalize(next, targetIndex);
}

function removeBlankLinesAfter(
	lines: string[],
	timestampIndex: number,
): string[] {
	const next = [...lines];
	const index = timestampIndex + 1;
	while (
		index < next.length - 1 &&
		isBlankLine(next[index] ?? "") &&
		!next[index]?.startsWith(OSC133_ZONE_END_FINAL)
	) {
		next.splice(index, 1);
	}
	return next;
}

function addTrailingRuleLine(
	lines: string[],
	width: number,
	theme: ThemeModule["theme"],
	marker?: string,
): string[] {
	const next = [...lines];
	let endPrefix = "";
	while (next.length > 0) {
		const lastIndex = next.length - 1;
		const line = next[lastIndex] ?? "";
		const { prefix, content } = splitZoneEndFinal(line);
		if (prefix) endPrefix = prefix;
		next[lastIndex] = content;
		if (!isBlankLine(content)) break;
		next.pop();
	}

	next.push(
		`${endPrefix}${renderDashedRuleLine(width, theme, "╌", marker)}`,
	);
	return next;
}

function getUserTimestamp(
	component: TimestampedUserMessage,
): string | undefined {
	const patched = component[COMPONENT_TIMESTAMP_PROPERTY];
	if (typeof patched === "string" && patched) return patched;

	if (typeof component.timestamp === "string" && component.timestamp) {
		return component.timestamp;
	}

	return undefined;
}

function setUserTimestamp(component: unknown, timestamp: string): void {
	(component as Record<string, unknown>)[COMPONENT_TIMESTAMP_PROPERTY] =
		timestamp;
}

function getComponentTimestamp(component: unknown): string | undefined {
	const timestamp = (component as Record<string, unknown>)[
		COMPONENT_TIMESTAMP_PROPERTY
	];
	return typeof timestamp === "string" && timestamp
		? timestamp
		: undefined;
}

function setComponentTimestamp(
	component: unknown,
	timestamp: string | undefined,
): void {
	if (!timestamp) return;
	(component as Record<string, unknown>)[COMPONENT_TIMESTAMP_PROPERTY] =
		timestamp;
}

function messageTimestamp(message: unknown): string | undefined {
	const timestamp = (
		message as { timestamp?: number | string } | undefined
	)?.timestamp;
	return formatTimestamp(timestamp);
}

function indexToolTimestampsFromMessage(message: unknown): void {
	const candidate = message as
		| {
				role?: string;
				content?: Array<{ type?: string; id?: string }>;
				timestamp?: number | string;
		  }
		| undefined;
	if (candidate?.role !== "assistant") return;
	const timestamp = messageTimestamp(candidate);
	if (!timestamp) return;

	for (const content of candidate.content ?? []) {
		if (
			content?.type === "toolCall" &&
			typeof content.id === "string"
		) {
			state.toolTimestamps.set(content.id, timestamp);
		}
	}
}

function indexToolTimestampsFromEntries(entries: unknown[]): void {
	state.toolTimestamps.clear();
	for (const entry of entries) {
		const message = (entry as { message?: unknown }).message;
		indexToolTimestampsFromMessage(message);
	}
}

function patchTimestampRender(
	componentClass: TimestampedRenderableComponentClass,
	timestampFor: (component: unknown) => string | undefined,
	theme: ThemeModule["theme"],
): void {
	const render = componentClass.prototype.render;
	componentClass.prototype.render = function (width: number) {
		const lines = render.call(this, width);
		return addTimestampToBlock(lines, width, timestampFor(this), theme);
	};
}

async function importInternal<T = unknown>(
	relativePath: string,
): Promise<T> {
	const url = pathToFileURL(
		path.join(getPkgRoot(), "dist", relativePath),
	).href;
	return (await import(url)) as T;
}

async function installPatches(): Promise<void> {
	if (state.patched) return;

	const [
		userModule,
		assistantModule,
		toolModule,
		bashModule,
		customModule,
		skillModule,
		branchModule,
		compactionModule,
		interactiveModeModule,
		themeModule,
	] = await Promise.all([
		importInternal<{
			UserMessageComponent: UserMessageComponentLike;
		}>("modes/interactive/components/user-message.js"),
		importInternal<{
			AssistantMessageComponent: AssistantMessageComponentLike;
		}>("modes/interactive/components/assistant-message.js"),
		importInternal<{
			ToolExecutionComponent: ToolExecutionComponentLike;
		}>("modes/interactive/components/tool-execution.js"),
		importInternal<{
			BashExecutionComponent: TimestampedRenderableComponentClass;
		}>("modes/interactive/components/bash-execution.js"),
		importInternal<{
			CustomMessageComponent: TimestampedRenderableComponentClass;
		}>("modes/interactive/components/custom-message.js"),
		importInternal<{
			SkillInvocationMessageComponent: TimestampedRenderableComponentClass;
		}>("modes/interactive/components/skill-invocation-message.js"),
		importInternal<{
			BranchSummaryMessageComponent: TimestampedRenderableComponentClass;
		}>("modes/interactive/components/branch-summary-message.js"),
		importInternal<{
			CompactionSummaryMessageComponent: TimestampedRenderableComponentClass;
		}>("modes/interactive/components/compaction-summary-message.js"),
		importInternal<{
			InteractiveMode: InteractiveModeLike;
		}>("modes/interactive/interactive-mode.js"),
		importInternal<ThemeModule>("modes/interactive/theme/theme.js"),
	]);

	const { UserMessageComponent } = userModule;
	const { AssistantMessageComponent } = assistantModule;
	const { ToolExecutionComponent } = toolModule;
	const { BashExecutionComponent } = bashModule;
	const { CustomMessageComponent } = customModule;
	const { SkillInvocationMessageComponent } = skillModule;
	const { BranchSummaryMessageComponent } = branchModule;
	const { CompactionSummaryMessageComponent } = compactionModule;
	const { InteractiveMode } = interactiveModeModule;
	const { theme } = themeModule;

	const userRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function (width: number) {
		const lines = userRender.call(this, width);
		const timestamp = getUserTimestamp(this);
		return replaceUserMessageBorders(lines, width, timestamp, theme);
	};

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (
		width: number,
	) {
		const lines = assistantRender.call(this, width);
		const timestamp = formatTimestamp(this.lastMessage?.timestamp);
		return addTimestampToBlock(lines, width, timestamp, theme, {
			marker: "🤖",
			trimBlankAfterTimestamp: true,
			trailingRuleMarker: "🤖",
		});
	};

	patchTimestampRender(
		ToolExecutionComponent,
		(component) => {
			const toolCallId = (component as { toolCallId?: unknown })
				.toolCallId;
			return typeof toolCallId === "string"
				? state.toolTimestamps.get(toolCallId)
				: undefined;
		},
		theme,
	);
	patchTimestampRender(
		BashExecutionComponent,
		getComponentTimestamp,
		theme,
	);
	patchTimestampRender(
		CustomMessageComponent,
		(component) =>
			getComponentTimestamp(component) ??
			messageTimestamp((component as { message?: unknown }).message),
		theme,
	);
	patchTimestampRender(
		SkillInvocationMessageComponent,
		getComponentTimestamp,
		theme,
	);
	patchTimestampRender(
		BranchSummaryMessageComponent,
		(component) =>
			messageTimestamp((component as { message?: unknown }).message),
		theme,
	);
	patchTimestampRender(
		CompactionSummaryMessageComponent,
		(component) =>
			messageTimestamp((component as { message?: unknown }).message),
		theme,
	);

	const addMessageToChat = InteractiveMode.prototype.addMessageToChat;
	InteractiveMode.prototype.addMessageToChat = function (
		message: { role?: string; timestamp?: number | string },
		options?: { populateHistory?: boolean },
	) {
		indexToolTimestampsFromMessage(message);
		const before = Array.isArray(this.chatContainer?.children)
			? this.chatContainer.children.length
			: 0;

		addMessageToChat.call(this, message, options);

		const timestamp = messageTimestamp(message);
		if (!timestamp) return;

		const children = this.chatContainer?.children;
		if (!Array.isArray(children)) return;

		for (let i = before; i < children.length; i++) {
			setComponentTimestamp(children[i], timestamp);
			if (children[i] instanceof UserMessageComponent) {
				setUserTimestamp(children[i], timestamp);
			}
		}
	};

	state.patched = true;
}

export default async function feedTimestamps(pi: ExtensionAPI) {
	await installPatches();

	pi.on("session_start", async (_event, ctx) => {
		indexToolTimestampsFromEntries(ctx.sessionManager.getBranch());
	});

	pi.on("session_tree", async (_event, ctx) => {
		indexToolTimestampsFromEntries(ctx.sessionManager.getBranch());
	});

	pi.on("message_update", async (event) => {
		indexToolTimestampsFromMessage(event.message);
	});

	pi.on("message_end", async (event) => {
		indexToolTimestampsFromMessage(event.message);
	});
}
