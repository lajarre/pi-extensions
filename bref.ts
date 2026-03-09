import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Markdown,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";

type BrefMode = "regular" | "detail" | "condensed";

type ToolLikeResult = {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
	details?: Record<string, unknown>;
};

type PatchState = {
	mode: BrefMode;
	patched: boolean;
	lastCtx?: ExtensionContext;
	terminalInputUnsubscribe?: (() => void) | undefined;
};

type ThemeModule = {
	theme: {
		fg(color: string, text: string): string;
		italic(text: string): string;
	};
};

declare global {
	// eslint-disable-next-line no-var
	var __piBrefState__: PatchState | undefined;
}

const state =
	globalThis.__piBrefState__ ??
	(globalThis.__piBrefState__ = {
		mode: "regular",
		patched: false,
	});

const pkgEntry = fileURLToPath(
	import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const pkgRoot = path.dirname(path.dirname(pkgEntry));

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

function shortenHome(value: string): string {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
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
		.filter((block) => block.type === "text" && typeof block.text === "string")
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

function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
	const pathArg =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: undefined;
	const query = typeof args.query === "string" ? args.query : undefined;
	const url = typeof args.url === "string" ? args.url : undefined;
	const command = typeof args.command === "string" ? args.command : undefined;
	const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
	const action = typeof args.action === "string" ? args.action : undefined;
	const agent = typeof args.agent === "string" ? args.agent : undefined;
	const chainName =
		typeof args.chainName === "string" ? args.chainName : undefined;
	const title = typeof args.title === "string" ? args.title : undefined;

	if (toolName === "subagent") {
		if (action) {
			const target = agent ?? chainName;
			return clip(
				target ? `${toolName} ${action} ${target}` : `${toolName} ${action}`,
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
			text += ` \"${title}\"`;
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
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
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
	if (toolName === "fetch_content") return imageCount > 0 ? `${imageCount} images` : "done";
	if (toolName === "todo") return firstLine ? clip(firstLine, 60) : "done";

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

	if (["read", "grep", "find", "ls"].includes(toolName) && lineCount > 0) {
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
	return [truncateToWidth(theme.fg("syntaxComment", "response"), width)];
}

async function importInternal<T = unknown>(relativePath: string): Promise<T> {
	const url = pathToFileURL(path.join(pkgRoot, "dist", relativePath)).href;
	return (await import(url)) as T;
}

async function installPatches(): Promise<void> {
	if (state.patched) return;

	const [
		assistantModule,
		toolModule,
		bashModule,
		customModule,
		skillModule,
		branchModule,
		compactionModule,
		themeModule,
	] = await Promise.all([
		importInternal<{ AssistantMessageComponent: any }>(
			"modes/interactive/components/assistant-message.js",
		),
		importInternal<{ ToolExecutionComponent: any }>(
			"modes/interactive/components/tool-execution.js",
		),
		importInternal<{ BashExecutionComponent: any }>(
			"modes/interactive/components/bash-execution.js",
		),
		importInternal<{ CustomMessageComponent: any }>(
			"modes/interactive/components/custom-message.js",
		),
		importInternal<{ SkillInvocationMessageComponent: any }>(
			"modes/interactive/components/skill-invocation-message.js",
		),
		importInternal<{ BranchSummaryMessageComponent: any }>(
			"modes/interactive/components/branch-summary-message.js",
		),
		importInternal<{ CompactionSummaryMessageComponent: any }>(
			"modes/interactive/components/compaction-summary-message.js",
		),
		importInternal<ThemeModule>("modes/interactive/theme/theme.js"),
	]);

	const { AssistantMessageComponent } = assistantModule;
	const { ToolExecutionComponent } = toolModule;
	const { BashExecutionComponent } = bashModule;
	const { CustomMessageComponent } = customModule;
	const { SkillInvocationMessageComponent } = skillModule;
	const { BranchSummaryMessageComponent } = branchModule;
	const { CompactionSummaryMessageComponent } = compactionModule;
	const { theme } = themeModule;

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (width: number) {
		if (getMode() !== "condensed") {
			return assistantRender.call(this, width);
		}

		const message = this.lastMessage;
		if (!message) return [];

		const lines: string[] = [];
		const container = new Container();
		const markdownTheme = this.markdownTheme;
		const hasToolCalls = Array.isArray(message.content)
			? message.content.some((item: any) => item?.type === "toolCall")
			: false;
		let insertedReplyLine = false;

		for (const content of message.content ?? []) {
			if (content?.type === "text" && typeof content.text === "string") {
				const text = content.text.trim();
				if (text) {
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
				lines.push(...renderBullet(theme, width, theme.italic("thinking")));
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
					...renderBullet(theme, width, theme.fg("error", errorMessage)),
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
		if (getMode() !== "condensed") {
			return toolRender.call(this, width);
		}

		const label = summarizeToolCall(
			typeof this.toolName === "string" ? this.toolName : "tool",
			(typeof this.args === "object" && this.args !== null ? this.args : {}) as Record<
				string,
				unknown
			>,
		);
		const detail = summarizeToolResult(
			typeof this.toolName === "string" ? this.toolName : "tool",
			this.result,
			Boolean(this.isPartial),
		);
		return renderBullet(theme, width, label, detail);
	};

	const bashRender = BashExecutionComponent.prototype.render;
	BashExecutionComponent.prototype.render = function (width: number) {
		if (getMode() !== "condensed") {
			return bashRender.call(this, width);
		}

		let detail: string | undefined;
		if (this.status === "running") {
			detail = "running";
		} else if (this.status === "cancelled") {
			detail = "cancelled";
		} else if (this.status === "error" && typeof this.exitCode === "number") {
			detail = `exit ${this.exitCode}`;
		} else {
			const output = typeof this.getOutput === "function" ? this.getOutput() : "";
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
		if (getMode() !== "condensed") {
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
	SkillInvocationMessageComponent.prototype.render = function (width: number) {
		if (getMode() !== "condensed") {
			return skillRender.call(this, width);
		}
		return renderBullet(
			theme,
			width,
			clip(`skill ${this.skillBlock?.name ?? ""}`, 80),
		);
	};

	const branchRender = BranchSummaryMessageComponent.prototype.render;
	BranchSummaryMessageComponent.prototype.render = function (width: number) {
		if (getMode() !== "condensed") {
			return branchRender.call(this, width);
		}
		return renderBullet(theme, width, "branch summary");
	};

	const compactionRender = CompactionSummaryMessageComponent.prototype.render;
	CompactionSummaryMessageComponent.prototype.render = function (width: number) {
		if (getMode() !== "condensed") {
			return compactionRender.call(this, width);
		}
		const tokenStr = Number(this.message?.tokensBefore ?? 0).toLocaleString();
		return renderBullet(theme, width, `compacted from ${tokenStr} tokens`);
	};

	state.patched = true;
}

function applyMode(ctx: ExtensionContext): void {
	state.lastCtx = ctx;
	ctx.ui.setToolsExpanded(getMode() === "detail");
	ctx.ui.setStatus(
		"bref",
		ctx.ui.theme.fg("dim", `bref:${getMode()}`),
	);
}

function cycleMode(ctx: ExtensionContext): void {
	setMode(nextMode(getMode()));
	applyMode(ctx);
	ctx.ui.notify(`bref: ${getMode()}`, "info");
}

function normalizeCommandArg(arg: string): string {
	return singleLine(arg.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "))
		.toLowerCase();
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

	const ensureInputHook = (ctx: ExtensionContext) => {
		state.lastCtx = ctx;
		if (state.terminalInputUnsubscribe) return;
		state.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+o")) return undefined;
			if (!state.lastCtx) return { consume: true };
			cycleMode(state.lastCtx);
			return { consume: true };
		});
	};

	pi.registerCommand("bref", {
		description: "Cycle or set bref display mode",
		handler: async (args, ctx) => {
			const normalized = normalizeCommandArg(args);
			if (!normalized || normalized === "status") {
				ctx.ui.notify(`bref: ${getMode()}`, "info");
				applyMode(ctx);
				return;
			}

			if (normalized === "cycle") {
				cycleMode(ctx);
				return;
			}

			const mode = setModeFromCommand(args);
			if (!mode) {
				ctx.ui.notify(
					"usage: /bref [regular|detail|condensed|cycle|status]",
					"warning",
				);
				return;
			}

			setMode(mode);
			applyMode(ctx);
			ctx.ui.notify(`bref: ${getMode()}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureInputHook(ctx);
		applyMode(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		ensureInputHook(ctx);
		applyMode(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		ensureInputHook(ctx);
		applyMode(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		ensureInputHook(ctx);
		applyMode(ctx);
	});

	pi.on("session_shutdown", async () => {
		state.terminalInputUnsubscribe?.();
		state.terminalInputUnsubscribe = undefined;
	});
}
