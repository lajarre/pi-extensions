/**
 * namenag — Auto-name unnamed Pi sessions before they get lost in /resume.
 *
 * Triggers:
 *   Hard (auto-names via LLM):
 *     - Compaction fires (session_compact)
 *     - ≥50 user turns (turn_end)
 *   Soft (notify only):
 *     - ≥10 user turns — toast reminder
 *
 * Uses the cheapest available model (by input token cost) to generate a
 * structured session name from early conversation context.
 * Falls back to ctx.model if no cheaper alternative is found.
 *
 * Also overrides /name:
 *   - /name          → force re-derive the session name
 *   - /name <name>   → set the session name explicitly
 *   - /name <Tab>    → complete with current or suggested name
 *
 * Guards: ctx.hasUI (skip in detached/sub-agent sessions).
 *
 * Zero configuration required.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	DESCRIPTION_PROMPT,
	structuredName,
	type DescriptionLLMFn,
	type ExecFn,
} from "./resolve.js";

const SOFT_THRESHOLD = 10;
const HARD_THRESHOLD = 50;

const FALLBACK_NAME_PROMPT = `You are a session naming assistant. Given conversation context, produce a short session name.

Rules:
- 2–4 words, kebab-case (e.g. "refactor-auth-module", "search-feature-shaping")
- Capture the primary topic or activity
- Be specific, not generic (not "coding-session" or "chat")
- Output ONLY the name, nothing else — no quotes, no explanation`;

type ResolvedModel = {
	model: any;
	apiKey: string;
};

export default function namenag(pi: ExtensionAPI) {
	let turnCount = 0;
	let softNotified = false;
	let generating = false;
	let suggestedName: string | null = null;
	let suggestionVersion = 0;

	const piExec: ExecFn = async (command, args, options) => {
		const result = await pi.exec(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.code,
		};
	};

	// ── Helpers ──────────────────────────────────────────────────────────

	function isActive(
		ctx: { hasUI: boolean },
		options: { ignoreExistingName?: boolean } = {},
	): boolean {
		return (
			ctx.hasUI &&
			(options.ignoreExistingName || !pi.getSessionName()) &&
			!generating
		);
	}

	function markNamed(name: string) {
		softNotified = true;
		suggestedName = name;
		suggestionVersion++;
	}

	function sanitizeGeneratedName(raw: string): string {
		return raw
			.toLowerCase()
			.replace(/[^a-z0-9-\s]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60);
	}

	function applyName(
		ctx: { ui: { notify(message: string, type?: "info"): void } },
		name: string,
		mode: "auto" | "manual",
	): void {
		pi.setSessionName(name);
		markNamed(name);

		if (mode === "manual") {
			ctx.ui?.notify?.(`Session named: ${name}`, "info");
			return;
		}

		ctx.ui?.notify?.(`Auto-named: ${name}. /name <name> to change.`, "info");
	}

	/** Extract text from the last 3 user messages (most recent first, ≤500 chars). */
	function gatherContext(ctx: { sessionManager: { getBranch(): SessionEntry[] } }): string {
		const entries = ctx.sessionManager.getBranch();
		const MAX_CHARS = 500;
		const MAX_MESSAGES = 3;
		const userMessages: string[] = [];

		for (
			let i = entries.length - 1;
			i >= 0 && userMessages.length < MAX_MESSAGES;
			i--
		) {
			const e = entries[i];
			if (e.type !== "message" || (e as any).message?.role !== "user") {
				continue;
			}

			const content = (e as any).message.content;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						text += `${block.text}\n`;
					}
				}
			}

			if (text.trim()) {
				userMessages.push(text.trim());
			}
		}

		return userMessages.join("\n").slice(0, MAX_CHARS).trim();
	}

	/** Pick the cheapest available model with a valid API key. */
	async function resolveModel(ctx: { modelRegistry: any; model: any }) {
		const available = ctx.modelRegistry.getAvailable();
		if (!Array.isArray(available) || available.length === 0) {
			if (!ctx.model) return null;
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			return apiKey ? { model: ctx.model, apiKey } : null;
		}

		const sorted = [...available].sort(
			(a: any, b: any) =>
				(a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity),
		);

		for (const candidate of sorted) {
			const apiKey = await ctx.modelRegistry.getApiKey(candidate);
			if (apiKey) return { model: candidate, apiKey };
		}

		return null;
	}

	async function generateWithPrompt(
		prompt: string,
		context: string,
		resolved: ResolvedModel,
	): Promise<string> {
		const userMessage: Message = {
			role: "user",
			content: [
				{ type: "text", text: `<conversation>\n${context}\n</conversation>` },
			],
			timestamp: Date.now(),
		};

		const response = await complete(
			resolved.model,
			{ systemPrompt: prompt, messages: [userMessage] },
			{ apiKey: resolved.apiKey, maxTokens: 64 },
		);

		return response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	}

	async function generateFallbackName(
		context: string,
		resolved: ResolvedModel,
	): Promise<string | null> {
		try {
			const raw = await generateWithPrompt(
				FALLBACK_NAME_PROMPT,
				context,
				resolved,
			);
			const name = sanitizeGeneratedName(raw);
			return name || null;
		} catch {
			return null;
		}
	}

	async function deriveStructuredSuggestion(
		ctx: any,
		options: { allowEmptyContext?: boolean } = {},
	): Promise<string | null> {
		const context = gatherContext(ctx);
		if (!context && !options.allowEmptyContext) return null;

		let resolved: ResolvedModel | null = null;
		if (context) {
			resolved = await resolveModel(ctx);
		}

		const llmCallback: DescriptionLLMFn = async (contextText: string) => {
			if (!resolved) return "";
			return generateWithPrompt(DESCRIPTION_PROMPT, contextText, resolved);
		};

		return structuredName(ctx.cwd, piExec, context, llmCallback);
	}

	async function updateSuggestedName(ctx: any): Promise<void> {
		const version = ++suggestionVersion;

		try {
			const current = pi.getSessionName()?.trim();
			if (current) {
				if (version === suggestionVersion) suggestedName = current;
				return;
			}

			const suggestion = await deriveStructuredSuggestion(ctx, {
				allowEmptyContext: true,
			});

			if (version === suggestionVersion) {
				suggestedName = suggestion;
			}
		} catch {
			if (version === suggestionVersion) {
				suggestedName = null;
			}
		}
	}

	/** Generate a structured session name and apply fallback when needed. */
	async function autoName(
		ctx: any,
		options: { ignoreExistingName?: boolean } = {},
	): Promise<void> {
		if (!isActive(ctx, options)) return;

		const context = gatherContext(ctx);
		if (!context) return;

		const resolved = await resolveModel(ctx);
		if (!resolved) {
			softNotify(ctx);
			return;
		}

		generating = true;
		try {
			const llmCallback: DescriptionLLMFn = async (contextText: string) => {
				return generateWithPrompt(
					DESCRIPTION_PROMPT,
					contextText,
					resolved,
				);
			};

			const name = await structuredName(ctx.cwd, piExec, context, llmCallback);
			if (name) {
				applyName(ctx, name, "auto");
				return;
			}

			const fallback = await generateFallbackName(context, resolved);
			if (fallback) {
				applyName(ctx, fallback, "auto");
				return;
			}

			softNotify(ctx);
		} catch {
			softNotify(ctx);
		} finally {
			generating = false;
		}
	}

	function softNotify(ctx: { hasUI: boolean; ui: any }): void {
		if (!ctx.hasUI || pi.getSessionName() || softNotified) return;
		softNotified = true;
		ctx.ui?.notify?.(
			"Session unnamed — /name to auto-name, /name <name> to set one.",
			"info",
		);
	}

	function resetState(ctx?: any) {
		turnCount = 0;
		softNotified = false;
		generating = false;
		suggestedName = pi.getSessionName() ?? null;
		suggestionVersion++;
		if (ctx?.hasUI) {
			void updateSuggestedName(ctx);
		}
	}

	async function forceAutoName(ctx: any): Promise<void> {
		await autoName(ctx, { ignoreExistingName: true });
		if (!pi.getSessionName()) {
			await updateSuggestedName(ctx);
		}
	}

	pi.registerCommand("name", {
		description: "Auto-name session or set it explicitly (usage: /name [new name])",
		getArgumentCompletions: (argumentPrefix) => {
			const current = pi.getSessionName()?.trim();
			const value = current || suggestedName?.trim();
			if (!value) return null;
			if (argumentPrefix && !value.startsWith(argumentPrefix)) return null;

			return [
				{
					value,
					label: value,
					description: current
						? "current session name"
						: "suggested session name",
				},
			];
		},
		handler: async (args, ctx) => {
			const name = args.trim();

			if (name) {
				applyName(ctx, name, "manual");
				return;
			}

			await forceAutoName(ctx);
		},
	});

	pi.registerTool({
		name: "name_auto",
		label: "Name Auto",
		description:
			"Derive a structured session name from environment (git branch, PR, project) + recent activity. " +
			"Call this to name or rename the current session.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			await forceAutoName(ctx);
			const name = pi.getSessionName();
			return {
				content: [
					{
						type: "text",
						text: name
							? `Session named: ${name}`
							: "Failed to derive name",
					},
				],
			};
		},
	});

	// ── Event Listeners ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => resetState(ctx));
	pi.on("session_switch", async (_event, ctx) => resetState(ctx));
	pi.on("session_fork", async (_event, ctx) => resetState(ctx));

	/** Hard trigger: compaction. */
	pi.on("session_compact", async (_event, ctx) => {
		if (isActive(ctx)) await autoName(ctx);
	});

	/** Soft + hard trigger: turn count. */
	pi.on("turn_end", async (_event, ctx) => {
		turnCount++;

		if (turnCount >= HARD_THRESHOLD && isActive(ctx)) {
			await autoName(ctx);
		} else if (turnCount >= SOFT_THRESHOLD && !softNotified && !pi.getSessionName() && ctx.hasUI) {
			softNotify(ctx);
		}

		if (!pi.getSessionName() && ctx.hasUI) {
			void updateSuggestedName(ctx);
		}
	});
}
