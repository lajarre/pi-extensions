/**
 * Session ID status indicator.
 *
 * Adds persistent footer metadata with both session name (if set) and session ID.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function getSessionLabel(ctx: {
    sessionManager: {
        getSessionName(): string | undefined;
        getSessionId(): string;
    };
}): string {
    const id = ctx.sessionManager.getSessionId();
    const name = ctx.sessionManager.getSessionName();
    return name ? `${name} • id: ${id}` : `Session ID: ${id}`;
}

export default function (pi: ExtensionAPI) {
    const updateFooter = async (_event: unknown, ctx: any) => {
        const line = getSessionLabel(ctx);
        ctx.ui.setStatus("session-metadata", ctx.ui.theme.fg("dim", line));
    };

    pi.on("session_start", updateFooter);
    pi.on("session_switch", updateFooter);
    pi.on("session_fork", updateFooter);
    pi.on("session_tree", updateFooter);
    pi.on("turn_start", updateFooter);
    pi.on("turn_end", updateFooter);
    pi.on("before_agent_start", updateFooter);

    pi.registerCommand("session-id", {
        description: "Show session ID in the status/footer",
        handler: async (_args, ctx) => {
            const line = getSessionLabel(ctx);
            ctx.ui.notify(line, "info");
        },
    });
}
