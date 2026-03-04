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
 * 2–4 word kebab-case session name from early conversation context.
 * Falls back to ctx.model if no cheaper alternative is found.
 *
 * Guards: ctx.hasUI (skip in detached/sub-agent sessions), named flag.
 *
 * Zero configuration required.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";

const SOFT_THRESHOLD = 10;
const HARD_THRESHOLD = 50;

const NAME_PROMPT = `You are a session naming assistant. Given conversation context, produce a short session name.

Rules:
- 2–4 words, kebab-case (e.g. "refactor-auth-module", "search-feature-shaping")
- Capture the primary topic or activity
- Be specific, not generic (not "coding-session" or "chat")
- Output ONLY the name, nothing else — no quotes, no explanation`;

export default function namenag(pi: ExtensionAPI) {
	let turnCount = 0;
	let named = false;
	let softNotified = false;
	let generating = false;

	// ── Helpers ──────────────────────────────────────────────────────────

	function isActive(ctx: { hasUI: boolean }): boolean {
		return ctx.hasUI && !named && !generating;
	}

	function markNamed() {
		named = true;
		softNotified = true; // no more nags of any kind
	}

	/** Extract text from the last 3 user messages (most recent first, ≤500 chars). */
	function gatherContext(ctx: { sessionManager: { getBranch(): SessionEntry[] } }): string {
		const entries = ctx.sessionManager.getBranch();
		const MAX_CHARS = 500;
		const MAX_MESSAGES = 3;
		const userMessages: string[] = [];

		for (let i = entries.length - 1; i >= 0 && userMessages.length < MAX_MESSAGES; i--) {
			const e = entries[i];
			if (e.type !== "message" || (e as any).message?.role !== "user") continue;

			const content = (e as any).message.content;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) text += block.text + "\n";
				}
			}

			if (text.trim()) userMessages.push(text.trim());
		}

		return userMessages.join("\n").slice(0, MAX_CHARS).trim();
	}

	/** Pick the cheapest available model with a valid API key, or fall back to ctx.model. */
	async function resolveModel(ctx: { modelRegistry: any; model: any }) {
		const available = ctx.modelRegistry.getAvailable();
		if (!Array.isArray(available) || available.length === 0) {
			// No models at all — use session model as last resort
			if (!ctx.model) return null;
			const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
			return apiKey ? { model: ctx.model, apiKey } : null;
		}

		// Sort by input cost ascending, pick the first one with a key
		const sorted = [...available].sort(
			(a: any, b: any) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity),
		);

		for (const candidate of sorted) {
			const apiKey = await ctx.modelRegistry.getApiKey(candidate);
			if (apiKey) return { model: candidate, apiKey };
		}

		return null;
	}

	/** Generate a session name via LLM and apply it. */
	async function autoName(ctx: any): Promise<void> {
		if (!isActive(ctx)) return;

		const context = gatherContext(ctx);
		if (!context) return;

		const resolved = await resolveModel(ctx);
		if (!resolved) {
			softNotify(ctx);
			return;
		}

		generating = true;
		try {
			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: `<conversation>\n${context}\n</conversation>` }],
				timestamp: Date.now(),
			};

			const response = await complete(
				resolved.model,
				{ systemPrompt: NAME_PROMPT, messages: [userMessage] },
				{ apiKey: resolved.apiKey, maxTokens: 64 },
			);

			const raw = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();

			// Sanitize: keep only kebab-case-friendly chars, truncate
			const name = raw
				.toLowerCase()
				.replace(/[^a-z0-9-\s]/g, "")
				.replace(/\s+/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 60);

			if (!name) {
				softNotify(ctx);
				return;
			}

			pi.setSessionName(name);
			markNamed();
			ctx.ui.notify(`Auto-named: ${name}. /name to change.`, "info");
		} catch {
			// LLM call failed — fall back to soft notify
			softNotify(ctx);
		} finally {
			generating = false;
		}
	}

	function softNotify(ctx: { hasUI: boolean; ui: any }): void {
		if (!ctx.hasUI || named || softNotified) return;
		softNotified = true;
		ctx.ui.notify("Session unnamed — /name <name> to set one.", "info");
	}

	function resetState() {
		turnCount = 0;
		softNotified = false;
		generating = false;
		named = !!pi.getSessionName();
	}

	// ── Event Listeners ─────────────────────────────────────────────────

	pi.on("session_start", async () => resetState());
	pi.on("session_switch", async () => resetState());
	pi.on("session_fork", async () => resetState());

	/** Hard trigger: compaction. */
	pi.on("session_compact", async (_event, ctx) => {
		if (isActive(ctx)) await autoName(ctx);
	});

	/** Soft + hard trigger: turn count. */
	pi.on("turn_end", async (_event, ctx) => {
		turnCount++;

		if (turnCount >= HARD_THRESHOLD && isActive(ctx)) {
			await autoName(ctx);
		} else if (turnCount >= SOFT_THRESHOLD && !softNotified && !named && ctx.hasUI) {
			softNotify(ctx);
		}
	});
}
