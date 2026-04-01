import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const SHORTCUT = Key.f8;
const STATUS_KEY = "copy-session-id";
const FEEDBACK_MS = 4000;

let clearFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

function showFeedback(ctx: ExtensionContext, sessionId: string): void {
	if (!ctx.hasUI) return;

	const lines = ["ID in clipboard!", sessionId];
	ctx.ui.notify(`ID in clipboard! ${sessionId}`, "info");
	ctx.ui.setStatus(STATUS_KEY, `ID in clipboard! ${sessionId}`);
	ctx.ui.setWidget(STATUS_KEY, lines, { placement: "belowEditor" });

	if (clearFeedbackTimer) {
		clearTimeout(clearFeedbackTimer);
	}

	clearFeedbackTimer = setTimeout(() => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
		clearFeedbackTimer = undefined;
	}, FEEDBACK_MS);
}

async function copySessionId(ctx: ExtensionContext): Promise<void> {
	const sessionId = ctx.sessionManager.getSessionId();

	if (!ctx.hasUI) {
		process.stdout.write(`${sessionId}\n`);
		return;
	}

	showFeedback(ctx, sessionId);
	await copyToClipboard(sessionId);
}

export default function copySessionIdExtension(pi: ExtensionAPI) {
	pi.registerCommand("sid", {
		description: "Copy current session ID to clipboard",
		handler: (_args, ctx) => copySessionId(ctx),
	});

	pi.registerCommand("session-id", {
		description: "Copy current session ID to clipboard",
		handler: (_args, ctx) => copySessionId(ctx),
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Copy current session ID to clipboard",
		handler: copySessionId,
	});
}
