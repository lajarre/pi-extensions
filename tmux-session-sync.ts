import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function extractUuid(
	sessionFile: string | undefined,
): string | undefined {
	if (!sessionFile) return undefined;
	const uuid = basename(sessionFile)
		.replace(/\.jsonl$/, "")
		.split("_")
		.pop();
	return uuid && UUID_RE.test(uuid) ? uuid : undefined;
}

function syncPaneMetadata(pi: ExtensionAPI, uuid: string): void {
	pi.exec("tmux", [
		"set-option",
		"-p",
		"@resurrect-metadata-pi-session",
		uuid,
	]).catch(() => {});
	pi.exec("tmux", [
		"select-pane",
		"-T",
		`pi:${uuid.slice(0, 8)}`,
	]).catch(() => {});
}

function handleSessionEvent(
	_event: unknown,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): void {
	if (!process.env.TMUX) return;
	const uuid = extractUuid(ctx.sessionManager.getSessionFile());
	if (uuid) syncPaneMetadata(pi, uuid);
}

export default function tmuxSessionSync(pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) =>
		handleSessionEvent(event, ctx, pi),
	);
	pi.on("session_switch", (event, ctx) =>
		handleSessionEvent(event, ctx, pi),
	);
	pi.on("session_fork", (event, ctx) =>
		handleSessionEvent(event, ctx, pi),
	);
}
