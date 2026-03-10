import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { attachEditorHook } from "./editor-hook.js";
import {
	alignFooterLine,
	buildFooterRight,
	buildFooterStatsLeft,
	buildPwdLine,
	injectLabelOnBorder,
	replaceHomePrefix,
	truncatePlain,
} from "./render.js";

export default function blaz(pi: ExtensionAPI) {
	function wrapEditor(editor: any) {
		if (!editor || editor.__blazWrapped) return editor;
		const render = editor.render.bind(editor);
		editor.render = (width: number) => {
			const lines = render(width);
			const sessionName = pi.getSessionName();
			if (!sessionName || lines.length === 0) return lines;
			const { prefix, label } = injectLabelOnBorder(lines[0]!, sessionName, width);
			const border = typeof editor.borderColor === "function"
				? editor.borderColor(prefix)
				: prefix;
			lines[0] = border + label;
			return lines;
		};
		editor.__blazWrapped = true;
		return editor;
	}

	function installEditorHook(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI) return;
		attachEditorHook(
			ctx.ui,
			(factory: any) => {
				return (tui: any, theme: any, kb: any) => wrapEditor(factory(tui, theme, kb));
			},
			(tui: any, theme: any, kb: any) => new CustomEditor(tui, theme, kb),
		);
	}

	function scheduleInstall(ctx: { hasUI: boolean; ui: any; sessionManager: any; modelRegistry: any; model: any; getContextUsage: () => any }) {
		if (!ctx.hasUI) return;
		installEditorHook(ctx);
		setTimeout(() => {
			installFooter(ctx);
		}, 0);
	}

	function installFooter(ctx: {
		hasUI: boolean;
		ui: any;
		sessionManager: any;
		modelRegistry: any;
		model: any;
		getContextUsage: () => any;
	}) {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const msg = entry.message as AssistantMessage;
						input += msg.usage.input;
						output += msg.usage.output;
						cacheRead += msg.usage.cacheRead;
						cacheWrite += msg.usage.cacheWrite;
						cost += msg.usage.cost.total;
					}

					const home = process.env.HOME || process.env.USERPROFILE;
					const cwd = replaceHomePrefix(process.cwd(), home);
					const branch = footerData.getGitBranch();
					const pwd = buildPwdLine(cwd, branch);
					const pwdLine = theme.fg("dim", truncatePlain(pwd, width));

					const contextUsage = ctx.getContextUsage();
					const model = ctx.model;
					const usingSubscription =
						typeof ctx.modelRegistry.isUsingOAuth === "function" && model
							? ctx.modelRegistry.isUsingOAuth(model)
							: false;
					const left = buildFooterStatsLeft({
						input,
						output,
						cacheRead,
						cacheWrite,
						cost,
						contextPercent: contextUsage?.percent ?? null,
						contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
						autoCompactEnabled: false,
						modelName: model?.id || "no-model",
						providerName: model?.provider,
						providerCount: footerData.getAvailableProviderCount(),
						thinkingLevel: pi.getThinkingLevel(),
						reasoning: !!model?.reasoning,
						usingSubscription,
					});
					const right = buildFooterRight({
						input,
						output,
						cacheRead,
						cacheWrite,
						cost,
						contextPercent: contextUsage?.percent ?? null,
						contextWindow: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
						autoCompactEnabled: false,
						modelName: model?.id || "no-model",
						providerName: model?.provider,
						providerCount: footerData.getAvailableProviderCount(),
						thinkingLevel: pi.getThinkingLevel(),
						reasoning: !!model?.reasoning,
						usingSubscription,
					});
					const statsLine = theme.fg(
						"dim",
						alignFooterLine(left, right, width),
					);

					const lines = [pwdLine, statsLine];
					const statuses = Array.from(footerData.getExtensionStatuses().entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
						.filter(Boolean);
					if (statuses.length > 0) {
						lines.push(theme.fg("dim", truncatePlain(statuses.join(" "), width)));
					}
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		scheduleInstall(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		scheduleInstall(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		scheduleInstall(ctx);
	});
	pi.on("model_select", async (_event, ctx) => {
		scheduleInstall(ctx);
	});
}
