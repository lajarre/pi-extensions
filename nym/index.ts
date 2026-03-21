/**
 * nym — Auto-name unnamed Pi sessions before they get lost in /resume.
 *
 * Triggers:
 *   Hard (auto-names via LLM):
 *     - Compaction fires (session_compact)
 *     - ≥50 user turns (turn_end)
 *   Soft (notify only):
 *     - ≥10 user turns — toast reminder
 *
 * Tries available models cheapest-first, one per provider, to generate a
 * structured session name from early conversation context.
 * If a provider fails (no credits, rate limit), skips to the next provider.
 *
 * Also adds /nym:
 *   - /nym          → force re-derive the session name
 *   - /nym <name>   → set the session name explicitly
 *   - /nym <Tab>    → complete with current or suggested name
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
import {
	DESCRIPTION_PROMPT,
	structuredName,
	type DescriptionLLMFn,
	type ExecFn,
} from "./resolve.js";

const SOFT_THRESHOLD = 10;
const HARD_THRESHOLD = 50;
import { appendFileSync } from "node:fs";
const NYM_DEBUG = !!process.env.NYM_DEBUG;
const NYM_LOG = process.env.NYM_DEBUG ? "/tmp/nym-debug.log" : null;

const FALLBACK_NAME_PROMPT = `You are a session naming assistant. Given conversation context, produce a short session name.

Rules:
- 1–3 words, kebab-case, MAX 20 characters (e.g. "refactor-auth", "debug-cache")
- Capture the primary topic or activity
- Be specific, not generic (not "coding-session" or "chat")
- Output ONLY the name, nothing else — no quotes, no explanation`;

type ResolvedModel = {
	model: any;
	apiKey: string;
};

export default function nym(pi: ExtensionAPI) {
	let turnCount = 0;
	let softNotified = false;
	let generating = false;
	let suggestedName: string | null = null;
	let suggestionVersion = 0;
	let deriving = false;
	let removeTerminalHook: (() => void) | undefined;

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

	function showGenerating(ctx: any) {
		ctx.ui?.setStatus?.("nym", "✦ naming…");
	}

	function clearGenerating(ctx: any) {
		ctx.ui?.setStatus?.("nym", undefined);
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

		ctx.ui?.notify?.(
			`Auto-named: ${name}. /nym to re-derive, /name <name> to change.`,
			"info",
		);
	}

	/** Extract text from the last 3 user messages (most recent first, ≤500 chars). */
	function gatherContext(ctx: { sessionManager: { getBranch(): SessionEntry[] } }): string {
		const entries = ctx.sessionManager.getBranch();
		const MAX_CHARS = 1500;
		const MAX_MESSAGES = 10;
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

	function dbg(...args: any[]) {
		if (!NYM_LOG) return;
		const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
		appendFileSync(NYM_LOG, `[nym ${new Date().toISOString()}] ${msg}\n`);
	}

	/**
	 * Build a ranked list of models to try, cheapest first.
	 * Deduplicates by provider so a failed provider is skipped
	 * entirely — the next candidate is always a different provider.
	 */
	async function resolveModelCandidates(
		ctx: { modelRegistry: any; model: any },
	): Promise<ResolvedModel[]> {
		const candidates: ResolvedModel[] = [];
		const seenProviders = new Set<string>();

		const available = ctx.modelRegistry.getAvailable();
		dbg("available models:", available?.length ?? 0);
		if (Array.isArray(available) && available.length > 0) {
			const sorted = [...available].sort(
				(a: any, b: any) =>
					(a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity),
			);

			for (const model of sorted) {
				const provider = model.provider ?? model.id?.split("/")[0];
				if (provider && seenProviders.has(provider)) {
					dbg("skip duplicate provider:", provider, model.id);
					continue;
				}
				const apiKey = await ctx.modelRegistry.getApiKey(model);
				if (!apiKey) {
					dbg("no api key for:", provider, model.id);
					continue;
				}
				if (provider) seenProviders.add(provider);
				candidates.push({ model, apiKey });
				dbg("candidate:", provider, model.id, `cost=${model.cost?.input}`);
			}
		}

		// Fallback: session's own model if not already covered.
		if (candidates.length === 0 && ctx.model) {
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			if (apiKey) {
				candidates.push({ model: ctx.model, apiKey });
				dbg("fallback to session model:", ctx.model.id);
			}
		}

		dbg("total candidates:", candidates.length);
		return candidates;
	}

	/** Single-model prompt call. Throws on failure. */
	function callModel(
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

		return complete(
			resolved.model,
			{ systemPrompt: prompt, messages: [userMessage] },
			{ apiKey: resolved.apiKey, maxTokens: 64 },
		).then((response) =>
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim(),
		);
	}

	/**
	 * Try prompt across candidates until one succeeds.
	 * Each failure skips to the next provider.
	 */
	async function generateWithPrompt(
		prompt: string,
		context: string,
		candidates: ResolvedModel[],
	): Promise<string> {
		const promptTag = prompt.includes("activity") ? "description" : "fallback";
		dbg(`generateWithPrompt[${promptTag}]: ${candidates.length} candidates, context=${context.length}chars`);
		for (const candidate of candidates) {
			const id = candidate.model?.id ?? "unknown";
			try {
				const result = await callModel(prompt, context, candidate);
				if (!result) {
					dbg(`generateWithPrompt[${promptTag}]: ${id} → empty, trying next`);
					continue;
				}
				dbg(`generateWithPrompt[${promptTag}]: ${id} → "${result}"`);
				return result;
			} catch (err: any) {
				dbg(`generateWithPrompt[${promptTag}]: ${id} FAILED:`, err?.message ?? err);
				continue;
			}
		}
		dbg(`generateWithPrompt[${promptTag}]: all candidates exhausted`);
		throw new Error("All model candidates exhausted");
	}

	async function generateFallbackName(
		context: string,
		candidates: ResolvedModel[],
	): Promise<string | null> {
		try {
			const raw = await generateWithPrompt(
				FALLBACK_NAME_PROMPT,
				context,
				candidates,
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

		let candidates: ResolvedModel[] = [];
		if (context) {
			candidates = await resolveModelCandidates(ctx);
		}

		const llmCallback: DescriptionLLMFn = async (contextText: string) => {
			if (candidates.length === 0) return "";
			return generateWithPrompt(DESCRIPTION_PROMPT, contextText, candidates);
		};

		return structuredName(ctx.cwd, piExec, context, llmCallback);
	}

	async function updateSuggestedName(ctx: any): Promise<void> {
		const version = ++suggestionVersion;
		deriving = true;
		showGenerating(ctx);

		try {
			const suggestion = await deriveStructuredSuggestion(ctx, {
				allowEmptyContext: true,
			});

			if (version === suggestionVersion) {
				// Bare project name isn't useful as a tab suggestion.
				suggestedName = suggestion?.includes(":") ? suggestion : null;
			}
		} catch {
			if (version === suggestionVersion) {
				suggestedName = null;
			}
		} finally {
			deriving = false;
			clearGenerating(ctx);
		}
	}

	/** Generate a structured session name and apply fallback when needed. */
	async function autoName(
		ctx: any,
		options: { ignoreExistingName?: boolean } = {},
	): Promise<void> {
		dbg("autoName: enter", { ignoreExisting: options.ignoreExistingName, hasName: !!pi.getSessionName(), generating });
		if (!isActive(ctx, options)) {
			dbg("autoName: not active, skip");
			return;
		}

		const context = gatherContext(ctx);
		dbg("autoName: context length:", context.length, context ? `"${context.slice(0, 80)}..."` : "(empty)");
		if (!context) {
			dbg("autoName: no context, skip");
			return;
		}

		const candidates = await resolveModelCandidates(ctx);
		if (candidates.length === 0) {
			dbg("autoName: no candidates, softNotify");
			softNotify(ctx);
			return;
		}

		generating = true;
		showGenerating(ctx);
		try {
			const llmCallback: DescriptionLLMFn = async (contextText: string) => {
				return generateWithPrompt(
					DESCRIPTION_PROMPT,
					contextText,
					candidates,
				);
			};

			const name = await structuredName(ctx.cwd, piExec, context, llmCallback);
			dbg("autoName: structuredName →", JSON.stringify(name));

			// Multi-segment name (has ":") is good. A bare project name
			// (no ":") needs a description appended via fallback.
			if (name && name.includes(":")) {
				dbg("autoName: applying multi-segment name");
				applyName(ctx, name, "auto");
				return;
			}

			dbg("autoName: bare name, trying fallback");
			const fallback = await generateFallbackName(context, candidates);
			dbg("autoName: fallback →", JSON.stringify(fallback));
			if (fallback && name) {
				applyName(ctx, `${name}:${fallback}`, "auto");
				return;
			}
			if (fallback) {
				applyName(ctx, fallback, "auto");
				return;
			}

			// All LLM calls failed — stay unnamed, retry on next trigger.
			dbg("autoName: all failed, softNotify");
			softNotify(ctx);
		} catch {
			softNotify(ctx);
		} finally {
			generating = false;
			clearGenerating(ctx);
		}
	}

	function softNotify(ctx: { hasUI: boolean; ui: any }): void {
		if (!ctx.hasUI || pi.getSessionName() || softNotified) return;
		softNotified = true;
		ctx.ui?.notify?.(
			"Session unnamed — /nym to auto-name, /name <name> to set one.",
			"info",
		);
	}

	function isBlankNymEditorText(text: string): boolean {
		return text.trim() === "/nym";
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
		dbg("forceAutoName: enter");
		await autoName(ctx, { ignoreExistingName: true });
		if (pi.getSessionName()) {
			dbg("forceAutoName: autoName succeeded:", pi.getSessionName());
			return;
		}

		dbg("forceAutoName: autoName didn't name, trying deriveStructuredSuggestion");
		const suggestion = await deriveStructuredSuggestion(ctx, {
			allowEmptyContext: true,
		});
		dbg("forceAutoName: suggestion →", JSON.stringify(suggestion));
		if (suggestion && suggestion.includes(":")) {
			applyName(ctx, suggestion, "auto");
			return;
		}

		dbg("forceAutoName: falling back to updateSuggestedName");
		await updateSuggestedName(ctx);
	}

	pi.registerCommand("nym", {
		description: "Auto-name session or set it explicitly (usage: /nym [new name])",
		getArgumentCompletions: (argumentPrefix) => {
			const current = pi.getSessionName()?.trim();
			const suggested = suggestedName?.trim();
			const completions: { value: string; label: string; description: string }[] = [];

			if (current) {
				if (!argumentPrefix || current.startsWith(argumentPrefix)) {
					completions.push({
						value: current,
						label: current,
						description: "current name",
					});
				}
			}

			if (suggested && suggested !== current) {
				if (!argumentPrefix || suggested.startsWith(argumentPrefix)) {
					completions.push({
						value: suggested,
						label: suggested,
						description: "suggested name",
					});
				}
			} else if (!suggested && (generating || deriving)) {
				completions.push({
					value: "",
					label: "✦ deriving…",
					description: "try again shortly",
				});
			}

			return completions.length > 0 ? completions : null;
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

	function installTerminalHook(ctx: any) {
		removeTerminalHook?.();
		removeTerminalHook = undefined;
		if (!ctx.hasUI) return;

		removeTerminalHook = ctx.ui.onTerminalInput((data: string) => {
			if (data !== "\r" && data !== "\n") return;
			if (!isBlankNymEditorText(ctx.ui.getEditorText())) return;

			ctx.ui.setEditorText("");
			void forceAutoName(ctx);
			return { consume: true };
		});
	}

	// ── Event Listeners ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});
	pi.on("session_shutdown", async () => {
		removeTerminalHook?.();
		removeTerminalHook = undefined;
	});

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

		// Keep suggestion fresh for /nym<tab>. Throttle for named
		// sessions (every 5 turns) since it's less urgent.
		const shouldUpdate = !pi.getSessionName() || turnCount % 5 === 0;
		if (ctx.hasUI && shouldUpdate) {
			void updateSuggestedName(ctx);
		}
	});
}
