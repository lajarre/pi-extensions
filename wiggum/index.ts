import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	SelectList,
	Text,
	truncateToWidth,
	visibleWidth,
	type SelectItem,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	loadSettings,
	resolveExitScript,
	REVIEW_GUIDELINES_TEMPLATE,
	type ExecFn,
	type WiggumSettings,
} from "./settings.js";
import {
	buildInlineAgent,
	runWiggumLoop,
	type LoopResult,
	type WiggumWidgetState,
} from "./engine.js";
import { assembleQualityContext, loadProjectGuidelines, type ReviewScope } from "./context.js";
import type { GateConfig } from "./gate.js";

const execFileAsync = promisify(execFile);

// ── State ────────────────────────────────────────────────────

let loopActive = false;
let currentIteration = 0;
let currentMax = 0;
let currentFlow = "";
let abortController: AbortController | null = null;
let settings: WiggumSettings;
let lastResult: LoopResult | null = null;
let lastLogFile: string | null = null;
let activeSpec: string | null = null;

// ── Log file resolution ──────────────────────────────────────

function resolveLogFile(ctx: ExtensionContext): string {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) {
		const baseName = path.basename(sessionFile, ".jsonl");
		const sessionsDir = path.dirname(sessionFile);
		const dir = path.join(sessionsDir, baseName);
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, "wiggum-log.jsonl");
	}
	// fallback: temp dir
	const tmpDir = path.join(os.tmpdir(), `wiggum-${Date.now()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	return path.join(tmpDir, "wiggum-log.jsonl");
}

// ── Exec adapter ─────────────────────────────────────────────

function makeExec(): ExecFn {
	return async (command, args, options) => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd,
				timeout: options?.timeout,
				maxBuffer: 10 * 1024 * 1024,
			});
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: 0,
			};
		} catch (err: unknown) {
			const e = err as {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? "",
				code: typeof e.code === "number" ? e.code : 1,
			};
		}
	};
}

// ── Guidelines path resolution ───────────────────────────────

async function resolveGuidelinesPath(
	cwd: string,
	exec: ExecFn,
): Promise<string> {
	const result = await exec(
		"git", ["rev-parse", "--show-toplevel"], { cwd },
	);
	if (result.code === 0 && result.stdout.trim()) {
		return path.join(result.stdout.trim(), "doc", "review-guidelines.md");
	}
	return path.join(cwd, "doc", "review-guidelines.md");
}

// ── Widget ───────────────────────────────────────────────────

const WIGGUM_WIDGET_KEY = "wiggum-loop";
const MAX_LINE_WIDTH = 80;

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	return sec > 0 ? `${min}m${sec}s` : `${min}m`;
}

function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	return truncateToWidth(text, maxWidth, "…");
}

function renderWiggumWidget(
	ctx: ExtensionContext,
	state: WiggumWidgetState | null,
): void {
	if (!ctx.hasUI) return;
	if (!state || state.phase === "done") {
		ctx.ui.setWidget(WIGGUM_WIDGET_KEY, undefined);
		return;
	}

	const lines: string[] = [];
	const theme = ctx.ui.theme;
	const iter = `${state.iteration}/${state.maxIterations}`;

	if (state.phase === "agent") {
		const elapsed = formatDuration(state.durationMs);
		const tok = `${formatTokens(state.tokens)} tok`;
		lines.push(truncLine(
			theme.fg("accent", `wiggum quality ${iter}`)
			+ ` | ${theme.fg("warning", "running")}`
			+ ` | ${elapsed} | ${tok}`,
			MAX_LINE_WIDTH,
		));
		const recent = state.recentOutput.slice(-3);
		for (const line of recent) {
			lines.push(truncLine(
				theme.fg("dim", `  > ${line}`),
				MAX_LINE_WIDTH,
			));
		}
	} else {
		// testing or gate
		lines.push(truncLine(
			theme.fg("accent", `wiggum quality ${iter}`)
			+ ` | ${state.phase}`,
			MAX_LINE_WIDTH,
		));
	}

	ctx.ui.setWidget(WIGGUM_WIDGET_KEY, lines);
}

// ── Helpers ──────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (loopActive) {
		ctx.ui.setStatus(
			"wiggum",
			`wiggum ${currentFlow} ${currentIteration}/${currentMax}`,
		);
	} else {
		ctx.ui.setStatus("wiggum", undefined);
	}
}

// ── Scope picker ─────────────────────────────────────────────

const SCOPE_ITEMS: SelectItem[] = [
	{ value: "uncommitted", label: "Uncommitted changes", description: "" },
	{ value: "last-commit", label: "Last commit", description: "" },
	{ value: "branch", label: "Branch vs main", description: "" },
];

async function pickScope(ctx: ExtensionContext): Promise<ReviewScope | null> {
	if (!ctx.hasUI) return "uncommitted";

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Select review scope"))));

		const selectList = new SelectList(SCOPE_ITEMS, SCOPE_ITEMS.length, {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
		});

		selectList.onSelect = (item) => done(item.value as string);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Enter to confirm, Esc to cancel")));
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 50, maxHeight: "50%" } }) as Promise<ReviewScope | null>;
}

// ── Guidelines gate picker ───────────────────────────────────

type GuidelinesChoice = {
	action: "create" | "specify";
	path: string;
};

async function pickGuidelinesAction(
	ctx: ExtensionContext,
	proposedPath: string,
): Promise<GuidelinesChoice | null> {
	if (!ctx.hasUI) return null;

	const items: SelectItem[] = [
		{ value: "create", label: `Create at ${proposedPath}`, description: "" },
		{ value: "specify", label: "Specify a different path", description: "" },
		{ value: "cancel", label: "Cancel", description: "" },
	];

	const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("warning", theme.bold("No review guidelines found"))));
		container.addChild(new Text(theme.fg("dim", "Wiggum requires a guidelines file to review against.")));

		const selectList = new SelectList(items, items.length, {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
		});

		selectList.onSelect = (item) => done(item.value as string);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "Enter to confirm, Esc to cancel")));
		container.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));

		return {
			render(width: number) { return container.render(width); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) { selectList.handleInput(data); tui.requestRender(); },
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: 60, maxHeight: "50%" } });

	if (result === "create") {
		return { action: "create", path: proposedPath };
	}

	if (result === "specify") {
		ctx.ui.notify(
			"Use --spec <path> or /wiggum guide <path> to specify a guidelines file.",
			"info",
		);
		return null;
	}

	return null; // cancel or esc
}

// ── Extension ────────────────────────────────────────────────

export default function wiggumExtension(pi: ExtensionAPI) {
	settings = loadSettings();

	pi.on("session_start", async () => {
		settings = loadSettings();
		loopActive = false;
		currentIteration = 0;
		currentMax = 0;
		currentFlow = "";
		abortController = null;
		lastResult = null;
		lastLogFile = null;
		activeSpec = null;
	});

	async function startQualityLoop(
		ctx: ExtensionContext,
		scope: ReviewScope,
		focus?: string,
		maxOverride?: number,
		specPath?: string,
	): Promise<LoopResult | null> {
		if (loopActive) {
			if (ctx.hasUI) ctx.ui.notify("Wiggum loop already active", "warning");
			return null;
		}

		const max = maxOverride ?? settings.maxIterations;
		const exec = makeExec();
		const cwd = ctx.cwd;
		const exitScript = resolveExitScript(settings, cwd);
		const logFile = resolveLogFile(ctx);
		lastLogFile = logFile;

		// ── Resolve guidelines (precedence chain) ────────
		let guidelinesContent: string | null = null;

		// 1. explicit --spec or tool spec
		if (specPath) {
			try {
				const content = fs.readFileSync(specPath, "utf-8").trim();
				if (!content) throw new Error("File is empty");
				guidelinesContent = content;
			} catch (err) {
				if (ctx.hasUI) ctx.ui.notify(`Cannot read spec: ${specPath} — ${err}`, "error");
				return null;
			}
		}

		// 2. activeSpec (set via /wiggum guide)
		if (!guidelinesContent && activeSpec) {
			try {
				const content = fs.readFileSync(activeSpec, "utf-8").trim();
				if (content) guidelinesContent = content;
			} catch {
				if (ctx.hasUI) ctx.ui.notify(`Bound spec unreadable: ${activeSpec}, trying auto-load...`, "warning");
			}
		}

		// 3. auto-load review-guidelines.md
		if (!guidelinesContent) {
			guidelinesContent = await loadProjectGuidelines(cwd, exec);
		}

		// 4. hard gate — no guidelines found
		if (!guidelinesContent) {
			if (!ctx.hasUI) {
				// tool path: return null, caller gets error
				return null;
			}

			const proposedPath = await resolveGuidelinesPath(cwd, exec);
			const choice = await pickGuidelinesAction(ctx, proposedPath);

			if (!choice) return null; // cancelled

			if (choice.action === "create") {
				fs.mkdirSync(path.dirname(choice.path), { recursive: true });
				fs.writeFileSync(choice.path, REVIEW_GUIDELINES_TEMPLATE);
				guidelinesContent = REVIEW_GUIDELINES_TEMPLATE;
				ctx.ui.notify(`Created ${choice.path}`, "info");
			}
		}

		const agentConfig = buildInlineAgent(settings);
		const gateConfig: GateConfig = {
			stopSignal: settings.stopSignal,
			testCommand: settings.testCommand,
			exitScript,
			minIterations: settings.minIterations,
		};

		loopActive = true;
		currentFlow = "quality";
		currentMax = max;
		currentIteration = 0;
		abortController = new AbortController();
		updateStatus(ctx);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Wiggum quality loop started (scope: ${scope}, max: ${max})`,
				"info",
			);
		}

		try {
			const result = await runWiggumLoop(
				{
					name: "quality",
					assembleContext: (iteration) =>
						assembleQualityContext({
							iteration,
							maxIterations: currentMax,
							scope,
							cwd,
							exec,
							reviewPrompt: settings.reviewPrompt,
							focus,
							stopSignal: settings.stopSignal,
							guidelinesContent,
						}),
					agentConfig,
					maxIterations: currentMax,
					gateConfig,
				},
				{
					cwd,
					exec,
					logFile,
					signal: abortController.signal,
					getMaxIterations: () => currentMax,
					onIterationStart: (iter, mx) => {
						currentIteration = iter;
						updateStatus(ctx);
						if (ctx.hasUI) ctx.ui.notify(`Wiggum iteration ${iter}/${mx} starting...`, "info");
					},
					onIterationEnd: (iter, mx, reason) => {
						currentIteration = iter;
						updateStatus(ctx);
						if (ctx.hasUI) ctx.ui.notify(`Wiggum iteration ${iter}/${mx}: ${reason}`, "info");
					},
					onProgress: (state) => renderWiggumWidget(ctx, state),
				},
			);

			const msg = result.exitReason === "clean"
				? `Wiggum quality loop complete after ${result.iterations} iteration(s): all gates passed`
				: result.exitReason === "stopped"
					? `Wiggum quality loop stopped after ${result.iterations} iteration(s)`
					: `Wiggum quality loop reached max iterations (${result.iterations})`;

			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			lastResult = result;
			return result;
		} catch (err) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Wiggum loop error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
			lastResult = null;
			return null;
		} finally {
			loopActive = false;
			currentIteration = 0;
			currentFlow = "";
			abortController = null;
			updateStatus(ctx);
			renderWiggumWidget(ctx, null);
		}
	}

	// ── Commands ─────────────────────────────────────────────

	pi.registerCommand("wiggum", {
		description: "Wiggum loop: /wiggum quality [focus], /wiggum stop, /wiggum status, /wiggum max N, /wiggum guide [path|clear]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase();

			if (subcommand === "stop") {
				if (!loopActive) {
					ctx.ui.notify("No wiggum loop active", "info");
				} else {
					abortController?.abort();
					ctx.ui.notify("Wiggum loop stopping...", "info");
				}
				return;
			}

			if (subcommand === "status") {
				const specInfo = activeSpec ? `\nSpec: ${activeSpec}` : "";
				if (loopActive) {
					ctx.ui.notify(
						`Wiggum ${currentFlow} loop: iteration ${currentIteration}/${currentMax}${specInfo}`,
						"info",
					);
				} else if (lastResult) {
					const logSuffix = lastLogFile ? ` Log: ${lastLogFile}` : "";
					ctx.ui.notify(
						`Wiggum loop inactive. Last run: ${lastResult.iterations} iteration(s), exit: ${lastResult.exitReason}.${logSuffix}${specInfo}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`Wiggum loop inactive (max: ${settings.maxIterations})${specInfo}`,
						"info",
					);
				}
				return;
			}

			if (subcommand === "max") {
				const n = parseInt(parts[1] ?? "", 10);
				if (isNaN(n) || n < 1) {
					ctx.ui.notify("Usage: /wiggum max <number>", "error");
					return;
				}
				settings.maxIterations = n;
				if (loopActive) currentMax = n;
				ctx.ui.notify(`Max iterations set to ${n}`, "info");
				updateStatus(ctx);
				return;
			}

			if (subcommand === "guide") {
				const guideArg = parts[1]?.trim();
				if (!guideArg) {
					ctx.ui.notify(
						activeSpec ? `Spec: ${activeSpec}` : "No spec bound",
						"info",
					);
				} else if (guideArg === "clear") {
					activeSpec = null;
					ctx.ui.notify("Spec binding cleared", "info");
				} else {
					try {
						fs.readFileSync(guideArg, "utf-8");
						activeSpec = guideArg;
						ctx.ui.notify(`Spec bound: ${guideArg}`, "info");
					} catch {
						ctx.ui.notify(`Cannot read spec file: ${guideArg}`, "error");
					}
				}
				return;
			}

			if (subcommand === "quality") {
				const qualityParts = parts.slice(1);
				let specPath: string | undefined;
				const specIdx = qualityParts.indexOf("--spec");
				if (specIdx !== -1) {
					const specArg = qualityParts[specIdx + 1];
					if (!specArg) {
						ctx.ui.notify("Usage: /wiggum quality --spec <path> [focus]", "error");
						return;
					}
					try {
						fs.readFileSync(specArg, "utf-8");
					} catch {
						ctx.ui.notify(`Cannot read spec file: ${specArg}`, "error");
						return;
					}
					specPath = specArg;
					qualityParts.splice(specIdx, 2);
				}
				const focus = qualityParts.join(" ").trim() || undefined;

				const scope = await pickScope(ctx);
				if (!scope) return; // user cancelled
				startQualityLoop(ctx, scope, focus, undefined, specPath).catch((err) => {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Wiggum loop error: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
				});
				return;
			}

			ctx.ui.notify(
				"Usage: /wiggum quality [focus] | stop | status | max N",
				"error",
			);
		},
	});

	// ── Tool ─────────────────────────────────────────────────

	pi.registerTool({
		name: "wiggum_loop",
		description:
			"Run a wiggum (ralph) loop — fresh-agent iterations until "
			+ "exit gate passes. Supports quality review flow.",
		parameters: Type.Object({
			flow: Type.String({
				description: 'Flow type: "quality"',
			}),
			start: Type.Optional(Type.Boolean({
				description: "Start the loop",
			})),
			stop: Type.Optional(Type.Boolean({
				description: "Stop the loop",
			})),
			scope: Type.Optional(Type.String({
				description:
					'"uncommitted" | "last-commit" | "branch" | freeform text',
			})),
			focus: Type.Optional(Type.String({
				description: "Additional review focus text",
			})),
			maxIterations: Type.Optional(Type.Number({
				description: "Override max iterations",
				minimum: 1,
			})),
			spec: Type.Optional(Type.String({
				description: "Path to spec/guidelines file to review against",
			})),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.stop) {
				if (!loopActive) {
					return {
						content: [{ type: "text", text: "No wiggum loop active" }],
					};
				}
				abortController?.abort();
				return {
					content: [{ type: "text", text: "Wiggum loop stopping..." }],
				};
			}

			if (params.start && params.flow === "quality") {
				const scope: ReviewScope = (params.scope as ReviewScope) || "uncommitted";

				// Pre-check guidelines in tool path — startQualityLoop
				// returns bare null with no context for the caller.
				if (!ctx.hasUI) {
					const exec = makeExec();
					const hasGuidelines = params.spec
						|| activeSpec
						|| await loadProjectGuidelines(ctx.cwd, exec);
					if (!hasGuidelines) {
						const proposedPath = await resolveGuidelinesPath(ctx.cwd, exec);
						return {
							content: [{
								type: "text",
								text: `No review guidelines found. Create doc/review-guidelines.md at: ${proposedPath}\nOr pass spec parameter with a path to your guidelines file.`,
							}],
							isError: true,
						};
					}
				}

				const result = await startQualityLoop(ctx, scope, params.focus, params.maxIterations, params.spec);
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							iterations: result?.iterations ?? 0,
							exitReason: result?.exitReason ?? "error",
							logFile: lastLogFile,
						}),
					}],
				};
			}

			// status
			const logSuffix = lastLogFile ? ` Log: ${lastLogFile}` : "";
			const specInfo = activeSpec ? ` Spec: ${activeSpec}` : "";
			const statusText = loopActive
				? `Wiggum ${currentFlow} loop: iteration ${currentIteration}/${currentMax}${specInfo}`
				: lastResult
					? `Wiggum loop inactive. Last run: ${lastResult.iterations} iteration(s), exit: ${lastResult.exitReason}.${logSuffix}${specInfo}`
					: `Wiggum loop inactive (max: ${settings.maxIterations})${specInfo}`;
			return {
				content: [{
					type: "text",
					text: statusText,
				}],
			};
		},
	});
}
