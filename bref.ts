import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";

type BrefMode = "regular" | "detail" | "condensed";
type BrefLane =
	| "user"
	| "assistant"
	| "subagent"
	| "todo"
	| "tool"
	| "bash"
	| "skill"
	| "custom"
	| "branch"
	| "compaction";

type BrefConfig = {
	expandedLanes?: unknown;
	visibleLanes?: unknown;
};

type BrefSessionConfig = {
	mode?: unknown;
	expandedLanes?: unknown;
	visibleLanes?: unknown;
};

type ToolLikeResult = {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
	details?: Record<string, unknown>;
};

type PatchState = {
	mode: BrefMode;
	patched: boolean;
	expandedLanes: Set<BrefLane>;
	defaultExpandedLanes: Set<BrefLane>;
	defaultsLoaded: boolean;
};

type PickerResult = {
	expandedLanes: BrefLane[];
	saveDefaults: boolean;
};

type ThemeColor =
	| "accent"
	| "bashMode"
	| "customMessageLabel"
	| "mdHeading"
	| "dim"
	| "muted"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxNumber"
	| "syntaxString"
	| "syntaxType"
	| "syntaxVariable"
	| "thinkingText"
	| "warning";

type ThemeBackgroundColor = "toolPendingBg";

type ThemeModule = {
	theme: {
		bg(color: string, text: string): string;
		fg(color: string, text: string): string;
		italic(text: string): string;
	};
};

type RenderableComponentClass = {
	prototype: { render(width: number): string[] };
};

type InteractiveModeLike = {
	prototype: {
		addMessageToChat(
			message: { role?: string },
			options?: unknown,
		): void;
		showNewVersionNotification(newVersion: string): void;
		showPackageUpdateNotification(packages: string[]): void;
		chatContainer?: { children?: unknown[] };
	};
};

type HideableRenderable = {
	render(width: number): string[];
	[HIDE_IN_BREF_PROPERTY]?: boolean;
};

const LANE_DEFINITIONS: Array<{ lane: BrefLane; label: string }> = [
	{ lane: "user", label: "user prompts" },
	{ lane: "assistant", label: "assistant replies" },
	{ lane: "subagent", label: "subagents" },
	{ lane: "todo", label: "todos" },
	{ lane: "tool", label: "tool calls" },
	{ lane: "bash", label: "bash" },
	{ lane: "skill", label: "skills" },
	{ lane: "custom", label: "session/meta" },
	{ lane: "branch", label: "branch summaries" },
	{ lane: "compaction", label: "compaction summaries" },
];

const ALL_LANES: BrefLane[] = LANE_DEFINITIONS.map(
	(definition) => definition.lane,
);
const LEGACY_VISIBLE_LANES = ALL_LANES.filter(
	(lane) => lane !== "subagent" && lane !== "todo",
);
const DEFAULT_EXPANDED_LANES: BrefLane[] = [
	"user",
	"assistant",
	"custom",
];
const CONDENSED_ROW_COLORS: Record<BrefLane, ThemeColor> = {
	user: "accent",
	assistant: "mdHeading",
	subagent: "customMessageLabel",
	todo: "syntaxNumber",
	tool: "syntaxType",
	bash: "bashMode",
	skill: "syntaxComment",
	custom: "accent",
	branch: "muted",
	compaction: "muted",
};

const VALID_LANES = new Set<BrefLane>(ALL_LANES);
const SESSION_TOOL_NAMES = new Set([
	"send_to_session",
	"list_sessions",
	"session_lineage",
	"session_ask",
	"session_search",
	"session_query",
	"fork_pi",
	"spawn_pi",
]);

const FULL_RESET_RE = /\x1b\[0m/g;
const RESET_PRESERVING_BACKGROUND = "\x1b[22m\x1b[23m\x1b[24m\x1b[39m";
const ANSI_RE =
	/\x1b(?:\][^\u0007]*(?:\u0007|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const BACKGROUND_ANSI_RE = /\x1b\[(?:48;[25];[0-9;]*|4[0-7]|10[0-7])m/;
const HIDE_IN_BREF_PROPERTY = "__piBrefHideWhenCondensed__";

declare global {
	// eslint-disable-next-line no-var
	var __piBrefState__: PatchState | undefined;
}

let state = globalThis.__piBrefState__;
if (!state) {
	state = {
		mode: "regular",
		patched: false,
		expandedLanes: new Set(DEFAULT_EXPANDED_LANES),
		defaultExpandedLanes: new Set(DEFAULT_EXPANDED_LANES),
		defaultsLoaded: false,
	};
	globalThis.__piBrefState__ = state;
}
const legacyState = state as PatchState & {
	visibleLanes?: Set<BrefLane>;
	defaultVisibleLanes?: Set<BrefLane>;
};
state.expandedLanes ??=
	legacyState.visibleLanes ?? new Set(DEFAULT_EXPANDED_LANES);
state.defaultExpandedLanes ??=
	legacyState.defaultVisibleLanes ?? new Set(DEFAULT_EXPANDED_LANES);
state.defaultsLoaded ??= false;

const pkgEntry = fileURLToPath(
	import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const pkgRoot = path.dirname(path.dirname(pkgEntry));
const agentDir =
	process.env.PI_CODING_AGENT_DIR ??
	path.join(os.homedir(), ".pi", "agent");
const defaultConfigPath = path.join(agentDir, "bref.json");
const keybindingsConfigPath = path.join(agentDir, "keybindings.json");
const sessionConfigType = "bref-config";
const brefShortcutKey = "bref.toggle";
const legacyBrefShortcutKey = "extension.bref.toggle";
const defaultBrefShortcuts = ["ctrl+shift+b"];

function getMode(): BrefMode {
	return state.mode;
}

function setMode(mode: BrefMode): void {
	state.mode = mode;
}

function nextMode(mode: BrefMode): BrefMode {
	switch (mode) {
		case "regular":
			return "detail";
		case "detail":
			return "condensed";
		case "condensed":
			return "regular";
	}
}

function isBrefEnabled(): boolean {
	return getMode() === "condensed";
}

function isExpandedLane(lane: BrefLane): boolean {
	return state.expandedLanes.has(lane);
}

function laneForTool(toolName: string): BrefLane {
	if (toolName === "subagent") return "subagent";
	if (toolName === "todo") return "todo";
	return SESSION_TOOL_NAMES.has(toolName) ? "custom" : "tool";
}

function isBrefMode(value: unknown): value is BrefMode {
	return (
		value === "regular" || value === "detail" || value === "condensed"
	);
}

function normalizeLane(value: unknown): BrefLane | undefined {
	return typeof value === "string" && VALID_LANES.has(value as BrefLane)
		? (value as BrefLane)
		: undefined;
}

function normalizeLanes(value: unknown): Set<BrefLane> | undefined {
	if (!Array.isArray(value)) return undefined;
	const lanes = new Set<BrefLane>();
	for (const item of value) {
		const lane = normalizeLane(item);
		if (lane) lanes.add(lane);
	}
	return lanes;
}

function orderedLanes(lanes: Set<BrefLane>): BrefLane[] {
	return ALL_LANES.filter((lane) => lanes.has(lane));
}

function storedExpandedLanes(
	config: BrefConfig | BrefSessionConfig,
): Set<BrefLane> | undefined {
	const hasExpandedLanes = Array.isArray(config.expandedLanes);
	const lanes = normalizeLanes(
		hasExpandedLanes ? config.expandedLanes : config.visibleLanes,
	);
	if (!lanes) return undefined;

	const hasAllCurrentLanes = ALL_LANES.every((lane) => lanes.has(lane));
	const hasAllLegacyLanes = LEGACY_VISIBLE_LANES.every((lane) =>
		lanes.has(lane),
	);
	if (!hasExpandedLanes && (hasAllCurrentLanes || hasAllLegacyLanes)) {
		return new Set(DEFAULT_EXPANDED_LANES);
	}

	return lanes;
}

function shortcutList(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}
	return undefined;
}

async function loadBrefShortcuts(): Promise<string[]> {
	try {
		const text = await fs.readFile(keybindingsConfigPath, "utf8");
		const config = JSON.parse(text) as Record<string, unknown>;
		const configured =
			shortcutList(config[brefShortcutKey]) ??
			shortcutList(config[legacyBrefShortcutKey]);
		if (configured) {
			return [
				...new Set(configured.map((key) => key.trim()).filter(Boolean)),
			];
		}
	} catch {
		// Missing/invalid keybindings keep the built-in bref shortcut.
	}
	return [...defaultBrefShortcuts];
}

function matchesAnyShortcut(
	data: string,
	shortcuts: string[],
): boolean {
	return shortcuts.some((shortcut) => matchesKey(data, shortcut));
}

async function loadDefaultConfig(): Promise<void> {
	if (state.defaultsLoaded) return;
	try {
		const text = await fs.readFile(defaultConfigPath, "utf8");
		const config = JSON.parse(text) as BrefConfig;
		const lanes = storedExpandedLanes(config);
		if (lanes) {
			state.defaultExpandedLanes = lanes;
		}
	} catch {
		// Keep startup quiet. Invalid/missing defaults fall back to built-ins.
	} finally {
		state.defaultsLoaded = true;
	}
}

async function saveDefaultConfig(
	lanes = state.expandedLanes,
): Promise<void> {
	const expandedLanes = orderedLanes(lanes);
	await fs.mkdir(path.dirname(defaultConfigPath), { recursive: true });
	await fs.writeFile(
		defaultConfigPath,
		`${JSON.stringify({ expandedLanes }, null, "\t")}\n`,
		"utf8",
	);
	state.defaultExpandedLanes = new Set(expandedLanes);
	state.defaultsLoaded = true;
}

function persistSessionState(pi: ExtensionAPI): void {
	pi.appendEntry<BrefSessionConfig>(sessionConfigType, {
		mode: getMode(),
		expandedLanes: orderedLanes(state.expandedLanes),
	});
}

async function restoreState(ctx: ExtensionContext): Promise<void> {
	await loadDefaultConfig();
	let savedConfig: BrefSessionConfig | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type === "custom" &&
			entry.customType === sessionConfigType
		) {
			savedConfig = entry.data as BrefSessionConfig | undefined;
		}
	}

	if (savedConfig) {
		state.mode = isBrefMode(savedConfig.mode)
			? savedConfig.mode
			: "regular";
		state.expandedLanes =
			storedExpandedLanes(savedConfig) ??
			new Set(state.defaultExpandedLanes);
		return;
	}

	state.mode = "regular";
	state.expandedLanes = new Set(state.defaultExpandedLanes);
}

function shortenHome(value: string): string {
	const home = os.homedir();
	return value.startsWith(home)
		? `~${value.slice(home.length)}`
		: value;
}

function shortUrl(value: string): string {
	try {
		const url = new URL(value);
		return `${url.hostname}${url.pathname}`;
	} catch {
		return value;
	}
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max = 72): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return content
		.filter(
			(block): block is { type?: string; text?: string } =>
				typeof block === "object" && block !== null,
		)
		.filter(
			(block) =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text ?? "");
}

function firstTextLine(content: unknown): string | undefined {
	const joined = textBlocks(content).join("\n").trim();
	if (!joined) return undefined;
	const line = joined.split(/\r?\n/, 1)[0] ?? "";
	const compact = singleLine(line);
	return compact || undefined;
}

function nonEmptyLineCount(text: string): number {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function summarizeToolCall(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const pathArg =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: undefined;
	const query = typeof args.query === "string" ? args.query : undefined;
	const url = typeof args.url === "string" ? args.url : undefined;
	const command =
		typeof args.command === "string" ? args.command : undefined;
	const pattern =
		typeof args.pattern === "string" ? args.pattern : undefined;
	const action =
		typeof args.action === "string" ? args.action : undefined;
	const agent = typeof args.agent === "string" ? args.agent : undefined;
	const chainName =
		typeof args.chainName === "string" ? args.chainName : undefined;
	const title = typeof args.title === "string" ? args.title : undefined;

	if (toolName === "subagent") {
		if (action) {
			const target = agent ?? chainName;
			return clip(
				target
					? `${toolName} ${action} ${target}`
					: `${toolName} ${action}`,
			);
		}
		if (Array.isArray(args.chain)) {
			return `${toolName} chain (${args.chain.length})`;
		}
		if (Array.isArray(args.tasks)) {
			return `${toolName} parallel (${args.tasks.length})`;
		}
		if (agent) {
			return clip(`${toolName} ${agent}`);
		}
	}

	if (toolName === "web_search") {
		if (Array.isArray(args.queries)) {
			return `${toolName} ${args.queries.length} queries`;
		}
		if (query) {
			return clip(`${toolName} ${query}`, 80);
		}
	}

	if (toolName === "fetch_content") {
		if (Array.isArray(args.urls)) {
			return `${toolName} ${args.urls.length} urls`;
		}
		if (url) {
			return clip(`${toolName} ${shortUrl(url)}`, 80);
		}
	}

	if (toolName === "todo") {
		let text = action ? `${toolName} ${action}` : toolName;
		if (title) {
			text += ` "${title}"`;
		}
		return clip(text);
	}

	if (command) {
		return clip(`${toolName} ${singleLine(command)}`, 80);
	}

	if (pattern && pathArg) {
		return clip(
			`${toolName} ${singleLine(pattern)} in ${shortenHome(pathArg)}`,
			80,
		);
	}

	if (pathArg) {
		let text = `${toolName} ${shortenHome(pathArg)}`;
		const offset =
			typeof args.offset === "number" ? args.offset : undefined;
		const limit =
			typeof args.limit === "number" ? args.limit : undefined;
		if (offset !== undefined) {
			const end = limit !== undefined ? offset + limit - 1 : undefined;
			text += end !== undefined ? `:${offset}-${end}` : `:${offset}`;
		}
		return clip(text, 80);
	}

	if (url) {
		return clip(`${toolName} ${shortUrl(url)}`, 80);
	}

	if (action) {
		return clip(`${toolName} ${action}`);
	}

	return toolName;
}

function compactNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return value.toLocaleString();
}

function compactDuration(ms: number): string {
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
	return `${ms}ms`;
}

function summarizeSubagentResult(
	result: ToolLikeResult,
	firstLine: string | undefined,
): string {
	const details = result.details ?? {};
	const mode =
		typeof details.mode === "string" ? details.mode : undefined;
	const runId =
		typeof details.runId === "string" ? details.runId : undefined;
	const asyncId =
		typeof details.asyncId === "string" ? details.asyncId : undefined;
	const id = runId ?? asyncId;
	const results = Array.isArray(details.results) ? details.results : [];

	if (results.length === 0) {
		if (result.isError) {
			return firstLine ? clip(`error: ${firstLine}`, 72) : "error";
		}
		if (mode === "management") {
			return firstLine ? clip(firstLine, 60) : "ok";
		}
		return id ? `queued ${id}` : "done";
	}

	const agents = new Set<string>();
	let failed = 0;
	let running = 0;
	let toolCount = 0;
	let tokens = 0;
	let durationMs = 0;

	for (const item of results) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as Record<string, unknown>;
		if (typeof entry.agent === "string") agents.add(entry.agent);

		const progress =
			typeof entry.progress === "object" && entry.progress !== null
				? (entry.progress as Record<string, unknown>)
				: undefined;
		const progressStatus =
			typeof progress?.status === "string"
				? progress.status
				: undefined;
		if (progressStatus === "running") running++;
		if (
			progressStatus !== "running" &&
			typeof entry.exitCode === "number" &&
			entry.exitCode !== 0
		) {
			failed++;
		}

		const progressSummary =
			typeof entry.progressSummary === "object" &&
			entry.progressSummary !== null
				? (entry.progressSummary as Record<string, unknown>)
				: undefined;
		const stats = progress ?? progressSummary;
		if (typeof stats?.toolCount === "number") {
			toolCount += stats.toolCount;
		}
		if (typeof stats?.tokens === "number") {
			tokens += stats.tokens;
		}
		if (typeof stats?.durationMs === "number") {
			durationMs += stats.durationMs;
		}
	}

	const agentLabel =
		agents.size === 1 ? [...agents][0] : `${results.length} agents`;
	const parts = [agentLabel];
	if (running > 0) {
		parts.push(`${running} running`);
	} else {
		parts.push(failed > 0 ? `${failed} failed` : "ok");
	}
	if (toolCount > 0) parts.push(`${toolCount} tools`);
	if (tokens > 0) parts.push(`${compactNumber(tokens)} tok`);
	if (durationMs > 0) parts.push(compactDuration(durationMs));
	if (id) parts.push(id);

	return clip(parts.filter(Boolean).join(" · "), 72);
}

function summarizeToolResult(
	toolName: string,
	result: ToolLikeResult | undefined,
	isPartial: boolean,
): string | undefined {
	if (isPartial && !result) {
		return "running";
	}
	if (!result) {
		return undefined;
	}

	const firstLine = firstTextLine(result.content);
	const allText = textBlocks(result.content).join("\n").trim();
	const lineCount = allText ? nonEmptyLineCount(allText) : 0;
	const imageCount = Array.isArray(result.content)
		? result.content.filter((item) => item?.type === "image").length
		: 0;

	if (toolName === "subagent") {
		return summarizeSubagentResult(result, firstLine);
	}

	if (result.isError) {
		if (firstLine) {
			return clip(`error: ${firstLine}`, 72);
		}
		return "error";
	}

	if (toolName === "write") return "written";
	if (toolName === "edit") return "edited";
	if (toolName === "web_search") return "done";
	if (toolName === "fetch_content")
		return imageCount > 0 ? `${imageCount} images` : "done";
	if (toolName === "todo")
		return firstLine ? clip(firstLine, 60) : "done";

	if (toolName === "bash") {
		const exitCode =
			typeof result.details?.exitCode === "number"
				? result.details.exitCode
				: undefined;
		if (exitCode !== undefined && exitCode !== 0) {
			return `exit ${exitCode}`;
		}
		if (lineCount > 0) {
			return `${lineCount} lines`;
		}
		return "ok";
	}

	if (
		["read", "grep", "find", "ls"].includes(toolName) &&
		lineCount > 0
	) {
		return `${lineCount} lines`;
	}

	if (imageCount > 0 && lineCount === 0) {
		return `${imageCount} images`;
	}

	if (lineCount > 3) {
		return `${lineCount} lines`;
	}

	if (firstLine) {
		return clip(firstLine, 60);
	}

	return "ok";
}

function renderBullet(
	theme: ThemeModule["theme"],
	width: number,
	label: string,
	detail?: string,
	color: ThemeColor = "syntaxComment",
	background: ThemeBackgroundColor = "toolPendingBg",
): string[] {
	let line = theme.fg(color, "↳");
	line += theme.fg(color, label);
	if (detail) {
		line += theme.fg("syntaxComment", ` — ${detail}`);
	}
	return [renderBackgroundRow(theme, width, line, background)];
}

function renderBackgroundRow(
	theme: ThemeModule["theme"],
	width: number,
	line: string,
	background: ThemeBackgroundColor,
): string {
	const truncated = truncateToWidth(line, width).replace(
		FULL_RESET_RE,
		RESET_PRESERVING_BACKGROUND,
	);
	const padding = Math.max(0, width - visibleWidth(truncated));
	return theme.bg(background, `${truncated}${" ".repeat(padding)}`);
}

function renderLaneBullet(
	theme: ThemeModule["theme"],
	width: number,
	lane: BrefLane,
	label: string,
	detail?: string,
): string[] {
	return renderBullet(
		theme,
		width,
		label,
		detail,
		CONDENSED_ROW_COLORS[lane],
	);
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function isRenderedBlankLine(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

function isLeadingSpacerLine(line: string): boolean {
	return isRenderedBlankLine(line) && !BACKGROUND_ANSI_RE.test(line);
}

function withoutLeadingBlankLines(lines: string[]): string[] {
	const firstContentIndex = lines.findIndex(
		(line) => !isLeadingSpacerLine(line),
	);
	if (firstContentIndex <= 0) return lines;
	return lines.slice(firstContentIndex);
}

function renderBrefTight(lines: string[]): string[] {
	return isBrefEnabled() ? withoutLeadingBlankLines(lines) : lines;
}

function removeNewTopLevelSpacers(
	container: { children?: unknown[] } | undefined,
	startIndex: number,
): void {
	if (!isBrefEnabled()) return;
	const children = container?.children;
	if (!Array.isArray(children)) return;
	for (let index = startIndex; index < children.length; ) {
		if (children[index] instanceof Spacer) {
			children.splice(index, 1);
			continue;
		}
		index++;
	}
}

function isRenderable(
	component: unknown,
): component is HideableRenderable {
	return (
		typeof component === "object" &&
		component !== null &&
		"render" in component &&
		typeof (component as { render?: unknown }).render === "function"
	);
}

function hideInBref(component: unknown): void {
	if (!isRenderable(component) || component[HIDE_IN_BREF_PROPERTY]) {
		return;
	}
	const render = component.render;
	component.render = function (width: number): string[] {
		return isBrefEnabled() ? [] : render.call(this, width);
	};
	component[HIDE_IN_BREF_PROPERTY] = true;
}

function hideNewChildrenInBref(
	container: { children?: unknown[] } | undefined,
	startIndex: number,
): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	for (let index = startIndex; index < children.length; index++) {
		hideInBref(children[index]);
	}
}

class BrefPicker {
	private selectedIndex = 0;
	private expandedLanes: Set<BrefLane>;
	private status = "";
	private statusTone: "success" | "error" = "success";
	private saving = false;

	constructor(
		lanes: Set<BrefLane>,
		private readonly theme: ThemeModule["theme"] & {
			bold?: (text: string) => string;
		},
		private readonly done: (result: PickerResult | null) => void,
		private readonly onSaveDefaults: (
			lanes: Set<BrefLane>,
		) => Promise<void>,
		private readonly applyShortcutKeys: string[],
		private readonly requestRender: () => void,
	) {
		this.expandedLanes = new Set(lanes);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}

		if (matchesAnyShortcut(data, this.applyShortcutKeys)) {
			this.apply();
			return;
		}

		if (matchesKey(data, Key.up) || data === "k") {
			this.move(-1);
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.move(1);
			return;
		}

		if (matchesKey(data, Key.space) || data === " ") {
			this.toggleSelected();
			return;
		}

		if (matchesKey(data, Key.ctrl("s")) || data === "\u0013") {
			void this.saveDefaults();
			return;
		}

		if (
			matchesKey(data, Key.ctrl("enter")) ||
			matchesKey(data, "ctrl+enter")
		) {
			void this.saveDefaultsAndApply();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.apply();
		}
	}

	render(width: number): string[] {
		const title = this.theme.fg(
			"accent",
			this.theme.bold?.("bref full lanes") ?? "bref full lanes",
		);
		const lines = [title, ""];

		for (let index = 0; index < LANE_DEFINITIONS.length; index++) {
			const definition = LANE_DEFINITIONS[index];
			const selected = index === this.selectedIndex;
			const checked = this.expandedLanes.has(definition.lane);
			const cursor = selected ? this.theme.fg("accent", "›") : " ";
			const checkbox = checked
				? this.theme.fg("success", "✓")
				: this.theme.fg("dim", " ");
			const label = selected
				? this.theme.fg("accent", definition.label)
				: definition.label;
			lines.push(`${cursor} [${checkbox}] ${label}`);
		}

		lines.push("");
		lines.push(
			this.theme.fg(
				"dim",
				"space full/compact · j/k move · enter apply · ctrl-enter save+apply · ctrl-s save · esc cancel",
			),
		);
		if (this.status) {
			lines.push(this.theme.fg(this.statusTone, this.status));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private move(delta: number): void {
		const length = LANE_DEFINITIONS.length;
		this.selectedIndex = (this.selectedIndex + delta + length) % length;
		this.status = "";
		this.statusTone = "success";
		this.requestRender();
	}

	private toggleSelected(): void {
		const lane = LANE_DEFINITIONS[this.selectedIndex]?.lane;
		if (!lane) return;
		if (this.expandedLanes.has(lane)) {
			this.expandedLanes.delete(lane);
		} else {
			this.expandedLanes.add(lane);
		}
		this.status = "";
		this.statusTone = "success";
		this.requestRender();
	}

	private apply(): void {
		this.done({
			expandedLanes: orderedLanes(this.expandedLanes),
			saveDefaults: false,
		});
	}

	private async saveDefaults(): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.status = "saving defaults…";
		this.statusTone = "success";
		this.requestRender();
		try {
			await this.onSaveDefaults(this.expandedLanes);
			this.status = "saved defaults";
			this.statusTone = "success";
		} catch {
			this.status = "failed to save defaults";
			this.statusTone = "error";
		} finally {
			this.saving = false;
			this.requestRender();
		}
	}

	private async saveDefaultsAndApply(): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.status = "saving defaults…";
		this.statusTone = "success";
		this.requestRender();
		try {
			await this.onSaveDefaults(this.expandedLanes);
			this.done({
				expandedLanes: orderedLanes(this.expandedLanes),
				saveDefaults: false,
			});
		} catch {
			this.status = "failed to save defaults";
			this.statusTone = "error";
			this.saving = false;
			this.requestRender();
		}
	}
}

async function importInternal<T = unknown>(
	relativePath: string,
): Promise<T> {
	const url = pathToFileURL(
		path.join(pkgRoot, "dist", relativePath),
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
		importInternal<{ UserMessageComponent: RenderableComponentClass }>(
			"modes/interactive/components/user-message.js",
		),
		importInternal<{
			AssistantMessageComponent: RenderableComponentClass;
		}>("modes/interactive/components/assistant-message.js"),
		importInternal<{
			ToolExecutionComponent: RenderableComponentClass;
		}>("modes/interactive/components/tool-execution.js"),
		importInternal<{
			BashExecutionComponent: RenderableComponentClass;
		}>("modes/interactive/components/bash-execution.js"),
		importInternal<{
			CustomMessageComponent: RenderableComponentClass;
		}>("modes/interactive/components/custom-message.js"),
		importInternal<{
			SkillInvocationMessageComponent: RenderableComponentClass;
		}>("modes/interactive/components/skill-invocation-message.js"),
		importInternal<{
			BranchSummaryMessageComponent: RenderableComponentClass;
		}>("modes/interactive/components/branch-summary-message.js"),
		importInternal<{
			CompactionSummaryMessageComponent: RenderableComponentClass;
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
		if (isBrefEnabled() && !isExpandedLane("user")) {
			return renderLaneBullet(theme, width, "user", "user prompt");
		}
		return renderBrefTight(userRender.call(this, width));
	};

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (
		width: number,
	) {
		const expandAssistant = isExpandedLane("assistant");
		// Pi updates this component field when Ctrl+T changes visibility.
		const showThinking =
			(this as { hideThinkingBlock?: boolean }).hideThinkingBlock !==
			true;
		if (!isBrefEnabled() || (expandAssistant && showThinking)) {
			return renderBrefTight(assistantRender.call(this, width));
		}

		const message = this.lastMessage;
		if (!message) return [];

		const lines: string[] = [];
		const container = new Container();
		const markdownTheme = this.markdownTheme;
		const hasToolCalls = Array.isArray(message.content)
			? message.content.some(
					(item: { type?: string }) => item?.type === "toolCall",
				)
			: false;
		let insertedReplyLine = false;

		for (const content of message.content ?? []) {
			if (
				content?.type === "text" &&
				typeof content.text === "string"
			) {
				const text = content.text.trim();
				if (text) {
					if (!expandAssistant) {
						if (!insertedReplyLine) {
							lines.push(
								...renderLaneBullet(
									theme,
									width,
									"assistant",
									"response",
									clip(singleLine(text), 72),
								),
							);
							insertedReplyLine = true;
						}
						continue;
					}

					container.clear();
					container.addChild(new Markdown(text, 1, 0, markdownTheme));
					lines.push(...container.render(width));
				}
				continue;
			}

			if (content?.type === "thinking") {
				if (!showThinking) continue;
				const thinking =
					typeof content.thinking === "string"
						? content.thinking.trim()
						: "";
				if (!thinking) continue;
				container.clear();
				container.addChild(
					new Markdown(thinking, 1, 0, markdownTheme, {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
				);
				lines.push(...container.render(width));
			}
		}

		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const errorMessage =
					typeof message.errorMessage === "string" &&
					message.errorMessage &&
					message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				lines.push(
					...renderLaneBullet(
						theme,
						width,
						"assistant",
						theme.fg("error", errorMessage),
					),
				);
			} else if (message.stopReason === "error") {
				const errorMessage =
					typeof message.errorMessage === "string" &&
					message.errorMessage.trim()
						? message.errorMessage.trim()
						: "Unknown error";
				lines.push(
					...renderLaneBullet(
						theme,
						width,
						"assistant",
						theme.fg("error", `Error: ${errorMessage}`),
					),
				);
			}
		}

		return lines;
	};

	const toolRender = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (width: number) {
		const toolName =
			typeof this.toolName === "string" ? this.toolName : "tool";
		const lane = laneForTool(toolName);
		if (!isBrefEnabled() || isExpandedLane(lane)) {
			return renderBrefTight(toolRender.call(this, width));
		}

		const label = summarizeToolCall(
			toolName,
			(typeof this.args === "object" && this.args !== null
				? this.args
				: {}) as Record<string, unknown>,
		);
		const detail = summarizeToolResult(
			toolName,
			this.result,
			Boolean(this.isPartial),
		);
		return renderLaneBullet(theme, width, lane, label, detail);
	};

	const bashRender = BashExecutionComponent.prototype.render;
	BashExecutionComponent.prototype.render = function (width: number) {
		if (!isBrefEnabled() || isExpandedLane("bash")) {
			return renderBrefTight(bashRender.call(this, width));
		}

		let detail: string | undefined;
		if (this.status === "running") {
			detail = "running";
		} else if (this.status === "cancelled") {
			detail = "cancelled";
		} else if (
			this.status === "error" &&
			typeof this.exitCode === "number"
		) {
			detail = `exit ${this.exitCode}`;
		} else {
			const output =
				typeof this.getOutput === "function" ? this.getOutput() : "";
			const count = output ? nonEmptyLineCount(output) : 0;
			detail = count > 0 ? `${count} lines` : "ok";
		}

		return renderLaneBullet(
			theme,
			width,
			"bash",
			clip(`bash ${singleLine(this.command ?? "")}`, 80),
			detail,
		);
	};

	const customRender = CustomMessageComponent.prototype.render;
	CustomMessageComponent.prototype.render = function (width: number) {
		if (!isBrefEnabled() || isExpandedLane("custom")) {
			return renderBrefTight(customRender.call(this, width));
		}

		const message = this.message;
		const summary = firstTextLine(message?.content);
		const label = summary
			? `[${message.customType}] ${summary}`
			: `[${message.customType}]`;
		return renderLaneBullet(theme, width, "custom", clip(label, 80));
	};

	const skillRender = SkillInvocationMessageComponent.prototype.render;
	SkillInvocationMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("skill")) {
			return renderBrefTight(skillRender.call(this, width));
		}
		return renderLaneBullet(
			theme,
			width,
			"skill",
			clip(`skill ${this.skillBlock?.name ?? ""}`, 80),
		);
	};

	const branchRender = BranchSummaryMessageComponent.prototype.render;
	BranchSummaryMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("branch")) {
			return renderBrefTight(branchRender.call(this, width));
		}
		return renderLaneBullet(theme, width, "branch", "branch summary");
	};

	const compactionRender =
		CompactionSummaryMessageComponent.prototype.render;
	CompactionSummaryMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("compaction")) {
			return renderBrefTight(compactionRender.call(this, width));
		}
		const tokenStr = Number(
			this.message?.tokensBefore ?? 0,
		).toLocaleString();
		return renderLaneBullet(
			theme,
			width,
			"compaction",
			`compacted from ${tokenStr} tokens`,
		);
	};

	const addMessageToChat = InteractiveMode.prototype.addMessageToChat;
	InteractiveMode.prototype.addMessageToChat = function (
		message: { role?: string },
		options?: unknown,
	) {
		const before = Array.isArray(this.chatContainer?.children)
			? this.chatContainer.children.length
			: 0;
		addMessageToChat.call(this, message, options);
		removeNewTopLevelSpacers(this.chatContainer, before);
	};

	const showNewVersionNotification =
		InteractiveMode.prototype.showNewVersionNotification;
	InteractiveMode.prototype.showNewVersionNotification = function (
		newVersion: string,
	) {
		const before = Array.isArray(this.chatContainer?.children)
			? this.chatContainer.children.length
			: 0;
		showNewVersionNotification.call(this, newVersion);
		hideNewChildrenInBref(this.chatContainer, before);
	};

	const showPackageUpdateNotification =
		InteractiveMode.prototype.showPackageUpdateNotification;
	InteractiveMode.prototype.showPackageUpdateNotification = function (
		packages: string[],
	) {
		const before = Array.isArray(this.chatContainer?.children)
			? this.chatContainer.children.length
			: 0;
		showPackageUpdateNotification.call(this, packages);
		hideNewChildrenInBref(this.chatContainer, before);
	};

	state.patched = true;
}

function applyMode(ctx: ExtensionContext): void {
	if (getMode() === "regular") {
		ctx.ui.setToolsExpanded(false);
	}
	if (getMode() === "detail") {
		ctx.ui.setToolsExpanded(true);
	}
	ctx.ui.setStatus("bref", isBrefEnabled() ? "bref" : undefined);
}

function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
	setMode(nextMode(getMode()));
	applyMode(ctx);
	persistSessionState(pi);
}

function disableBref(pi: ExtensionAPI, ctx: ExtensionContext): void {
	setMode(ctx.ui.getToolsExpanded() ? "detail" : "regular");
	applyMode(ctx);
	persistSessionState(pi);
}

async function openBrefPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	brefShortcuts: string[],
): Promise<void> {
	await loadDefaultConfig();
	if (!ctx.hasUI) {
		setMode("condensed");
		applyMode(ctx);
		persistSessionState(pi);
		return;
	}
	const result = await ctx.ui.custom<PickerResult | null>(
		(tui, theme, _keybindings, done) =>
			new BrefPicker(
				state.expandedLanes,
				theme,
				done,
				saveDefaultConfig,
				brefShortcuts,
				() => tui.requestRender(),
			),
		{
			overlay: true,
			overlayOptions: {
				width: 72,
				minWidth: 48,
				maxHeight: 18,
				anchor: "center",
				margin: 1,
			},
		},
	);

	if (!result) return;
	state.expandedLanes = new Set(result.expandedLanes);
	if (result.saveDefaults) {
		await saveDefaultConfig(state.expandedLanes);
	}
	setMode("condensed");
	applyMode(ctx);
	persistSessionState(pi);
}

async function toggleBref(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	brefShortcuts: string[],
): Promise<void> {
	if (isBrefEnabled()) {
		disableBref(pi, ctx);
		return;
	}
	await openBrefPicker(pi, ctx, brefShortcuts);
}

function normalizeCommandArg(arg: string): string {
	return singleLine(
		arg.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
	).toLowerCase();
}

function setModeFromCommand(arg: string): BrefMode | undefined {
	const normalized = normalizeCommandArg(arg);
	const token = normalized.split(/\s+/, 1)[0] ?? "";
	switch (token) {
		case "regular":
		case "detail":
		case "condensed":
			return token;
		default:
			return undefined;
	}
}

export default async function bref(pi: ExtensionAPI) {
	await installPatches();
	const brefShortcuts = await loadBrefShortcuts();

	for (const shortcut of brefShortcuts) {
		pi.registerShortcut(shortcut, {
			description: `Toggle bref display mode (${brefShortcutKey})`,
			handler: async (ctx) => {
				await toggleBref(pi, ctx, brefShortcuts);
			},
		});
	}

	pi.registerCommand("bref", {
		description: "Open bref picker or set display mode",
		handler: async (args, ctx) => {
			const normalized = normalizeCommandArg(args);
			if (!normalized) {
				await toggleBref(pi, ctx, brefShortcuts);
				return;
			}

			if (normalized === "picker") {
				await openBrefPicker(pi, ctx, brefShortcuts);
				return;
			}

			if (normalized === "cycle") {
				cycleMode(pi, ctx);
				return;
			}

			const mode = setModeFromCommand(args);
			if (!mode) {
				ctx.ui.notify(
					"usage: /bref [picker|regular|detail|condensed|cycle]",
					"warning",
				);
				return;
			}

			setMode(mode);
			applyMode(ctx);
			persistSessionState(pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await restoreState(ctx);
		applyMode(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await restoreState(ctx);
		applyMode(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		await restoreState(ctx);
		applyMode(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreState(ctx);
		applyMode(ctx);
	});
}
