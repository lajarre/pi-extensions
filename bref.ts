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
	truncateToWidth,
} from "@mariozechner/pi-tui";

type BrefMode = "regular" | "detail" | "condensed";
type BrefLane =
	| "user"
	| "assistant"
	| "thinking"
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

type ThemeModule = {
	theme: {
		fg(color: string, text: string): string;
		italic(text: string): string;
	};
};

type RenderableComponentClass = {
	prototype: { render(width: number): string[] };
};

const LANE_DEFINITIONS: Array<{ lane: BrefLane; label: string }> = [
	{ lane: "user", label: "user prompts" },
	{ lane: "assistant", label: "assistant replies" },
	{ lane: "thinking", label: "thinking" },
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
const DEFAULT_EXPANDED_LANES: BrefLane[] = [
	"user",
	"assistant",
	"custom",
];

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
const defaultConfigPath = path.join(
	os.homedir(),
	".pi",
	"agent",
	"bref.json",
);
const sessionConfigType = "bref-config";

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

	if (!hasExpandedLanes && lanes.size === ALL_LANES.length) {
		return new Set(DEFAULT_EXPANDED_LANES);
	}

	return lanes;
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

	if (result.isError) {
		if (firstLine) {
			return clip(`error: ${firstLine}`, 72);
		}
		return "error";
	}

	if (toolName === "write") return "written";
	if (toolName === "edit") return "edited";
	if (toolName === "subagent") return "done";
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
): string[] {
	let line = theme.fg("syntaxComment", "↳");
	line += theme.fg("dim", label);
	if (detail) {
		line += theme.fg("syntaxComment", ` — ${detail}`);
	}
	return [truncateToWidth(line, width)];
}

function renderReplyLine(
	theme: ThemeModule["theme"],
	width: number,
): string[] {
	return [
		truncateToWidth(theme.fg("syntaxComment", "response"), width),
	];
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
			this.done({
				expandedLanes: orderedLanes(this.expandedLanes),
				saveDefaults: false,
			});
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
	const { theme } = themeModule;

	const userRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function (width: number) {
		if (isBrefEnabled() && !isExpandedLane("user")) {
			return renderBullet(theme, width, "user prompt");
		}
		return userRender.call(this, width);
	};

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (
		width: number,
	) {
		const expandAssistant = isExpandedLane("assistant");
		const expandThinking = isExpandedLane("thinking");
		if (!isBrefEnabled() || (expandAssistant && expandThinking)) {
			return assistantRender.call(this, width);
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
								...renderBullet(
									theme,
									width,
									"response",
									clip(singleLine(text), 72),
								),
							);
							insertedReplyLine = true;
						}
						continue;
					}

					if (!insertedReplyLine) {
						lines.push(...renderReplyLine(theme, width));
						insertedReplyLine = true;
					}
					container.clear();
					container.addChild(new Markdown(text, 1, 0, markdownTheme));
					lines.push(...container.render(width));
				}
				continue;
			}

			if (
				content?.type === "thinking" &&
				typeof content.thinking === "string" &&
				content.thinking.trim()
			) {
				if (expandThinking) {
					container.clear();
					container.addChild(
						new Markdown(content.thinking.trim(), 1, 0, markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					lines.push(...container.render(width));
				} else {
					lines.push(
						...renderBullet(theme, width, theme.italic("thinking")),
					);
				}
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
					...renderBullet(
						theme,
						width,
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
					...renderBullet(
						theme,
						width,
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
			return toolRender.call(this, width);
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
		return renderBullet(theme, width, label, detail);
	};

	const bashRender = BashExecutionComponent.prototype.render;
	BashExecutionComponent.prototype.render = function (width: number) {
		if (!isBrefEnabled() || isExpandedLane("bash")) {
			return bashRender.call(this, width);
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

		return renderBullet(
			theme,
			width,
			clip(`bash ${singleLine(this.command ?? "")}`, 80),
			detail,
		);
	};

	const customRender = CustomMessageComponent.prototype.render;
	CustomMessageComponent.prototype.render = function (width: number) {
		if (!isBrefEnabled() || isExpandedLane("custom")) {
			return customRender.call(this, width);
		}

		const message = this.message;
		const summary = firstTextLine(message?.content);
		const label = summary
			? `[${message.customType}] ${summary}`
			: `[${message.customType}]`;
		return renderBullet(theme, width, clip(label, 80));
	};

	const skillRender = SkillInvocationMessageComponent.prototype.render;
	SkillInvocationMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("skill")) {
			return skillRender.call(this, width);
		}
		return renderBullet(
			theme,
			width,
			clip(`skill ${this.skillBlock?.name ?? ""}`, 80),
		);
	};

	const branchRender = BranchSummaryMessageComponent.prototype.render;
	BranchSummaryMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("branch")) {
			return branchRender.call(this, width);
		}
		return renderBullet(theme, width, "branch summary");
	};

	const compactionRender =
		CompactionSummaryMessageComponent.prototype.render;
	CompactionSummaryMessageComponent.prototype.render = function (
		width: number,
	) {
		if (!isBrefEnabled() || isExpandedLane("compaction")) {
			return compactionRender.call(this, width);
		}
		const tokenStr = Number(
			this.message?.tokensBefore ?? 0,
		).toLocaleString();
		return renderBullet(
			theme,
			width,
			`compacted from ${tokenStr} tokens`,
		);
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
): Promise<void> {
	if (isBrefEnabled()) {
		disableBref(pi, ctx);
		return;
	}
	await openBrefPicker(pi, ctx);
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

	pi.registerShortcut("ctrl+shift+b", {
		description: "Toggle bref display mode",
		handler: async (ctx) => {
			await toggleBref(pi, ctx);
		},
	});

	pi.registerCommand("bref", {
		description: "Open bref picker or set display mode",
		handler: async (args, ctx) => {
			const normalized = normalizeCommandArg(args);
			if (!normalized) {
				await toggleBref(pi, ctx);
				return;
			}

			if (normalized === "picker") {
				await openBrefPicker(pi, ctx);
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
