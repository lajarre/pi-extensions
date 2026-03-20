import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const ANSI_RE =
	/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1b\\))/g;
const USER_TIMESTAMP_PROPERTY = "__piFeedTimestamp__";

type ThemeModule = {
	theme: {
		fg(color: string, text: string): string;
	};
};

type UserMessageComponentLike = {
	prototype: {
		render(width: number): string[];
		timestamp?: string | null;
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
	[USER_TIMESTAMP_PROPERTY]?: string;
};

type PatchState = {
	patched: boolean;
	pkgRoot?: string;
};

declare global {
	// eslint-disable-next-line no-var
	var __piFeedTimestampsState__: PatchState | undefined;
}

const state =
	globalThis.__piFeedTimestampsState__ ??
	(globalThis.__piFeedTimestampsState__ = {
		patched: false,
	});

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

function formatTimestamp(timestamp?: number): string | undefined {
	if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;

	const date = new Date(timestamp);
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
		date.getDate(),
	)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
		date.getSeconds(),
	)}`;
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function renderRightAlignedTimestamp(
	width: number,
	timestamp: string,
	theme?: ThemeModule["theme"],
): string {
	const text = timestamp.length > width ? timestamp.slice(-width) : timestamp;
	const rendered = theme ? theme.fg("dim", text) : text;
	const spacing = Math.max(0, width - stripAnsi(rendered).length);
	return `${" ".repeat(spacing)}${rendered}`;
}

function replaceTopPaddingLine(
	lines: string[],
	width: number,
	timestamp: string,
	theme?: ThemeModule["theme"],
): string[] {
	if (lines.length === 0) return lines;

	const prefix = lines[0]?.startsWith(OSC133_ZONE_START)
		? OSC133_ZONE_START
		: "";
	lines[0] = `${prefix}${renderRightAlignedTimestamp(width, timestamp, theme)}`;
	return lines;
}

function getUserTimestamp(component: TimestampedUserMessage): string | undefined {
	const patched = component[USER_TIMESTAMP_PROPERTY];
	if (typeof patched === "string" && patched) return patched;

	if (typeof component.timestamp === "string" && component.timestamp) {
		return component.timestamp;
	}

	return undefined;
}

function setUserTimestamp(component: unknown, timestamp: string): void {
	(component as Record<string, unknown>)[USER_TIMESTAMP_PROPERTY] = timestamp;
}

async function importInternal<T = unknown>(relativePath: string): Promise<T> {
	const url = pathToFileURL(path.join(getPkgRoot(), "dist", relativePath)).href;
	return (await import(url)) as T;
}

async function installPatches(): Promise<void> {
	if (state.patched) return;

	const [userModule, assistantModule, interactiveModeModule, themeModule] =
		await Promise.all([
			importInternal<{
				UserMessageComponent: UserMessageComponentLike;
			}>("modes/interactive/components/user-message.js"),
			importInternal<{
				AssistantMessageComponent: AssistantMessageComponentLike;
			}>("modes/interactive/components/assistant-message.js"),
			importInternal<{
				InteractiveMode: InteractiveModeLike;
			}>("modes/interactive/interactive-mode.js"),
			importInternal<ThemeModule>("modes/interactive/theme/theme.js"),
		]);

	const { UserMessageComponent } = userModule;
	const { AssistantMessageComponent } = assistantModule;
	const { InteractiveMode } = interactiveModeModule;
	const { theme } = themeModule;

	const userRender = UserMessageComponent.prototype.render;
	UserMessageComponent.prototype.render = function (width: number) {
		const lines = userRender.call(this, width);
		const timestamp = getUserTimestamp(this);
		return timestamp
			? replaceTopPaddingLine(lines, width, timestamp, theme)
			: lines;
	};

	const assistantRender = AssistantMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = function (width: number) {
		const lines = assistantRender.call(this, width);
		const timestamp = formatTimestamp(this.lastMessage?.timestamp);
		return timestamp
			? replaceTopPaddingLine(lines, width, timestamp, theme)
			: lines;
	};

	const addMessageToChat = InteractiveMode.prototype.addMessageToChat;
	InteractiveMode.prototype.addMessageToChat = function (
		message: { role?: string; timestamp?: number },
		options?: { populateHistory?: boolean },
	) {
		const before = Array.isArray(this.chatContainer?.children)
			? this.chatContainer.children.length
			: 0;

		addMessageToChat.call(this, message, options);

		if (message?.role !== "user") return;

		const timestamp = formatTimestamp(message.timestamp);
		if (!timestamp) return;

		const children = this.chatContainer?.children;
		if (!Array.isArray(children)) return;

		for (let i = before; i < children.length; i++) {
			if (children[i] instanceof UserMessageComponent) {
				setUserTimestamp(children[i], timestamp);
			}
		}
	};

	state.patched = true;
}

export default async function feedTimestamps(_pi: ExtensionAPI) {
	await installPatches();
}
