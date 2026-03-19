/**
 * condense — Condense long dictated prompts before sending.
 *
 * Usage: /condense <long rambling dictated text>
 *
 * Calls the cheapest available model to distill the input into a
 * clear, concise prompt, then places the result in the editor for
 * review. Press Enter to send, or edit further.
 *
 * Model selection: cheapest-first across providers (same approach
 * as nym). Falls back to session model if nothing cheaper is
 * available.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONDENSE_PROMPT = `You are an input editor. The user dictated a prompt for a coding assistant using voice-to-text. It's verbose, repetitive, or rambling.

Rewrite it as a clear, concise prompt that preserves ALL intent, constraints, and details. Do not drop requirements.

Rules:
- Keep the user's voice/tone (first person, direct)
- Remove filler, repetition, false starts, verbal tics
- Preserve technical terms, names, paths, code references exactly
- Structure with line breaks if multiple distinct requests
- Output ONLY the rewritten prompt — no preamble, no quotes, no explanation`;

type ResolvedModel = {
	model: any;
	apiKey: string;
};

async function resolveModelCandidates(
	ctx: { modelRegistry: any; model: any },
): Promise<ResolvedModel[]> {
	const candidates: ResolvedModel[] = [];
	const seenProviders = new Set<string>();

	const available = ctx.modelRegistry.getAvailable();
	if (Array.isArray(available) && available.length > 0) {
		const sorted = [...available].sort(
			(a: any, b: any) =>
				(a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity),
		);

		for (const model of sorted) {
			const provider =
				model.provider ?? model.id?.split("/")[0];
			if (provider && seenProviders.has(provider)) continue;

			const apiKey =
				await ctx.modelRegistry.getApiKey(model);
			if (!apiKey) continue;

			if (provider) seenProviders.add(provider);
			candidates.push({ model, apiKey });
		}
	}

	if (candidates.length === 0 && ctx.model) {
		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (apiKey) candidates.push({ model: ctx.model, apiKey });
	}

	return candidates;
}

async function condenseText(
	text: string,
	candidates: ResolvedModel[],
): Promise<string> {
	const message: Message = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};

	for (const { model, apiKey } of candidates) {
		try {
			const response = await complete(
				model,
				{ systemPrompt: CONDENSE_PROMPT, messages: [message] },
				{ apiKey, maxTokens: 2048 },
			);

			const result = response.content
				.filter(
					(c): c is { type: "text"; text: string } =>
						c.type === "text",
				)
				.map((c) => c.text)
				.join("")
				.trim();

			if (result) return result;
		} catch {
			continue;
		}
	}

	throw new Error("All model candidates exhausted");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("condense", {
		description:
			"Condense a long dictated prompt into a clear, " +
			"concise version (placed in editor for review)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(
					"Usage: /condense <long text to condense>",
					"warning",
				);
				return;
			}

			ctx.ui.setStatus("condense", "✦ condensing…");

			try {
				const candidates =
					await resolveModelCandidates(ctx);
				if (candidates.length === 0) {
					ctx.ui.notify(
						"No model available for condensing",
						"error",
					);
					return;
				}

				const condensed = await condenseText(
					text,
					candidates,
				);
				ctx.ui.setEditorText(condensed);
				ctx.ui.notify(
					"Condensed — review and press Enter to send",
					"info",
				);
			} catch (err: any) {
				ctx.ui.notify(
					`Condense failed: ${err?.message ?? err}`,
					"error",
				);
			} finally {
				ctx.ui.setStatus("condense", undefined);
			}
		},
	});
}
