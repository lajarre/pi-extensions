/**
 * Compaction Model Override
 *
 * Routes compaction summarization to Opus 4.6 with xhigh thinking,
 * regardless of which model is active in the session. Opus produces
 * higher-quality summaries due to deeper reasoning and better
 * context awareness.
 *
 * Manual `/compact <instructions>` is also routed through Opus.
 * Falls back to default compaction if Opus is unavailable.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";

const COMPACTION_PROVIDER = "anthropic";
const COMPACTION_MODEL = "claude-opus-4-6";
const COMPACTION_THINKING: "xhigh" = "xhigh";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		// Find Opus 4.6
		const model = ctx.modelRegistry.find(
			COMPACTION_PROVIDER,
			COMPACTION_MODEL,
		);
		if (!model) {
			ctx.ui.notify(
				`⚠️ ${COMPACTION_MODEL} not found, falling back to default compaction`,
				"warning",
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(
				`⚠️ ${COMPACTION_MODEL} auth failed: ${auth.error} — falling back to default compaction`,
				"warning",
			);
			return;
		}
		if (!auth.apiKey && !auth.headers) {
			ctx.ui.notify(
				`⚠️ No request auth for ${COMPACTION_PROVIDER}, falling back to default compaction`,
				"warning",
			);
			return;
		}

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		ctx.ui.notify(
			`🧠 Compacting ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) with ${COMPACTION_MODEL}:${COMPACTION_THINKING}...`,
			"info",
		);

		const conversationText = serializeConversation(
			convertToLlm(allMessages),
		);
		const previousContext = previousSummary
			? `\n\nPrevious session summary for context:\n${previousSummary}`
			: "";
		const customContext = customInstructions
			? `\n\nAdditional focus instructions from the user:\n${customInstructions}`
			: "";

		const prompt = `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}${customContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`;

		try {
			const response = await completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 8192,
					reasoning: COMPACTION_THINKING,
					signal,
				},
			);

			const summary = response.content
				.filter(
					(c): c is { type: "text"; text: string } => c.type === "text",
				)
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted)
					ctx.ui.notify(
						"⚠️ Compaction summary was empty, falling back to default",
						"warning",
					);
				return;
			}

			ctx.ui.notify(
				`✅ Compacted with ${COMPACTION_MODEL}:${COMPACTION_THINKING}`,
				"info",
			);

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			const message =
				error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`⚠️ ${COMPACTION_MODEL} compaction failed: ${message} — falling back to default`,
				"warning",
			);
			return;
		}
	});
}
