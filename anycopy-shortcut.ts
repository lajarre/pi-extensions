import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const ANYCOPY_ENTRY_SPECIFIER =
	"pi-anycopy/extensions/anycopy/index.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type AnycopyModule = {
	default: (pi: ExtensionAPI) => void;
};

function nodeGlobalRoot(): string {
	return join(
		dirname(dirname(process.execPath)),
		"lib",
		"node_modules",
	);
}

function resolveWithRequire(): string | undefined {
	try {
		return createRequire(import.meta.url).resolve(
			ANYCOPY_ENTRY_SPECIFIER,
		);
	} catch {
		return undefined;
	}
}

function resolveWithNpmRoot(): string | undefined {
	try {
		const root = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const candidate = join(
			root,
			"pi-anycopy",
			"extensions",
			"anycopy",
			"index.ts",
		);
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

function resolveWithNodePrefix(): string | undefined {
	const candidate = join(
		nodeGlobalRoot(),
		"pi-anycopy",
		"extensions",
		"anycopy",
		"index.ts",
	);
	return existsSync(candidate) ? candidate : undefined;
}

async function resolveAnycopyEntryUrl(): Promise<string> {
	try {
		return await import.meta.resolve(ANYCOPY_ENTRY_SPECIFIER);
	} catch {}

	const resolved =
		resolveWithRequire() ??
		resolveWithNpmRoot() ??
		resolveWithNodePrefix();
	if (resolved) return pathToFileURL(resolved).href;

	throw new Error(
		"Unable to resolve pi-anycopy. Install it with `pi install npm:pi-anycopy`.",
	);
}

function toShortcutCommandContext(
	ctx: ExtensionContext,
): ExtensionCommandContext {
	const commandCtx = ctx as Partial<ExtensionCommandContext>;
	const unsupported = async () => {
		ctx.ui.notify(
			"This /anycopy action needs the slash command path",
			"warning",
		);
		return { cancelled: true };
	};

	return {
		...ctx,
		waitForIdle:
			commandCtx.waitForIdle?.bind(commandCtx) ??
			(async () => {
				while (!ctx.isIdle()) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}),
		newSession: commandCtx.newSession?.bind(commandCtx) ?? unsupported,
		fork: commandCtx.fork?.bind(commandCtx) ?? unsupported,
		navigateTree:
			commandCtx.navigateTree?.bind(commandCtx) ??
			(async () => {
				ctx.ui.notify(
					"Tree navigation from Ctrl+Shift+T is not available; run /anycopy for Enter navigation.",
					"warning",
				);
				return { cancelled: true };
			}),
		switchSession:
			commandCtx.switchSession?.bind(commandCtx) ?? unsupported,
		reload:
			commandCtx.reload?.bind(commandCtx) ??
			(async () => {
				ctx.ui.notify("Run /reload directly", "warning");
			}),
	};
}

export default async function anycopyShortcut(
	pi: ExtensionAPI,
): Promise<void> {
	const { default: registerAnycopy } = (await import(
		await resolveAnycopyEntryUrl()
	)) as AnycopyModule;

	let command: CommandOptions | undefined;
	registerAnycopy({
		registerCommand(name: string, options: CommandOptions) {
			if (name === "anycopy") {
				command = options;
			}
		},
		setLabel: pi.setLabel.bind(pi),
		appendEntry: pi.appendEntry.bind(pi),
	} as ExtensionAPI);

	if (!command) {
		throw new Error("Failed to capture /anycopy command handler");
	}

	pi.registerShortcut("ctrl+shift+t", {
		description: "Open /anycopy",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current reply to finish",
					"warning",
				);
				return;
			}

			await command.handler("", toShortcutCommandContext(ctx));
		},
	});
}
