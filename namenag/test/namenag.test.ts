/**
 * namenag extension — unit tests.
 *
 * Tests the core logic by simulating the Pi extension lifecycle
 * (session_start, turn_end, session_compact) with a minimal mock harness.
 *
 * Run:  npx tsx --test test/namenag.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assembleSegments,
	detectWorktree,
	type ExecFn,
	extractRepoName,
	resolveBranch,
	resolveDescription,
	resolvePR,
	resolveProject,
	resolveSubfolder,
	resolveWorktreeName,
	stripBranchPrefix,
	stripWorktreePrefix,
	structuredName,
	truncateSegment,
	type WorktreeInfo,
} from "../resolve.js";

// ─── Minimal Mock Harness ────────────────────────────────────────────────────

interface Notification {
	message: string;
	level: string;
}

type Handler = (event: any, ctx: any) => Promise<void>;

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockPi(opts: { hasModel?: boolean } = {}) {
	const handlers: Record<string, Handler[]> = {};
	const notifications: Notification[] = [];
	const terminalInputListeners = new Set<(data: string) => any>();
	let sessionName: string | undefined;
	let editorText = "";

	const ui = {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		onTerminalInput(handler: (data: string) => any) {
			terminalInputListeners.add(handler);
			return () => terminalInputListeners.delete(handler);
		},
		setEditorText(text: string) {
			editorText = text;
		},
		pasteToEditor(text: string) {
			editorText += text;
		},
		setStatus(_key: string, _text: string | undefined) {},
		getEditorText() {
			return editorText;
		},
	};

	/** Stub models with costs for cheapest-model resolution. */
	const cheapModel = {
		provider: "test",
		id: "test-cheap",
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
	};
	const expensiveModel = {
		provider: "test",
		id: "test-expensive",
		cost: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 },
	};

	const sessionManager = {
		getBranch(): any[] {
			return [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "Help me refactor the auth module" },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "Sure, let me help." }] },
				},
			];
		},
	};

	const modelRegistry = {
		getAvailable() {
			return opts.hasModel === false ? [] : [expensiveModel, cheapModel];
		},
		find(_provider: string, _id: string) {
			return cheapModel;
		},
		async getApiKey(_model: any) {
			return "test-key";
		},
	};

	const ctx = {
		hasUI: true,
		ui,
		sessionManager,
		modelRegistry,
		model: opts.hasModel === false ? undefined : expensiveModel,
	};

	const commands = new Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => any[] | null;
			handler: (args: any, ctx: any) => Promise<void>;
		}
	>();

	const api: any = {
		on(event: string, handler: Handler) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		registerCommand(
			name: string,
			command: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => any[] | null;
				handler: (args: any, ctx: any) => Promise<void>;
			},
		) {
			commands.set(name, command);
		},
		registerTool(_tool: any) {},
		async exec(_command: string, _args: string[], _opts?: any) {
			return { stdout: "", stderr: "", code: 0 };
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		getSessionName() {
			return sessionName;
		},
	};

	return {
		api,
		ctx,
		handlers,
		commands,
		notifications,
		getSessionName: () => sessionName,
		setSessionName: (n: string | undefined) => {
			sessionName = n;
		},
		async fire(event: string, eventData: any = {}) {
			for (const h of handlers[event] ?? []) {
				await h(eventData, ctx);
			}
		},
		async runCommand(name: string, args: any = {}) {
			const command = commands.get(name);
			if (!command) throw new Error(`Command not found: ${name}`);
			await command.handler(args, ctx);
		},
		getCommandCompletions(name: string, prefix = "") {
			const command = commands.get(name);
			if (!command?.getArgumentCompletions) return null;
			return command.getArgumentCompletions(prefix);
		},
		setEditorText(text: string) {
			editorText = text;
		},
		getEditorText() {
			return editorText;
		},
		sendTerminalInput(data: string) {
			for (const listener of terminalInputListeners) {
				const result = listener(data);
				if (result?.consume) return result;
			}
			return undefined;
		},
	};
}

// ─── Test harness: register handlers that mirror the extension ───────────────

/**
 * Registers event handlers that mirror namenag.ts logic but with injectable
 * LLM behavior. This lets us test the full event flow without ESM mocking.
 */
function registerTestHandlers(
	api: any,
	opts: {
		autoNameResult?: string;
		autoNameFails?: boolean;
		hasModel?: boolean;
		captureContext?: (context: string) => void;
		structuredResult?: string;
		fallbackResult?: string;
		suggestedResult?: string;
	} = {},
) {
	const SOFT = 10;
	const HARD = 50;
	const hasModel = opts.hasModel ?? true;

	let turnCount = 0;
	let softNotified = false;
	let generating = false;
	let suggestedName: string | null = api.getSessionName() ?? null;

	function isActive(
		ctx: { hasUI: boolean },
		options: { ignoreExistingName?: boolean } = {},
	) {
		return (
			ctx.hasUI &&
			(options.ignoreExistingName || !api.getSessionName()) &&
			!generating
		);
	}

	function markNamed(name: string) {
		softNotified = true;
		suggestedName = name;
	}

	function softNotify(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI || api.getSessionName() || softNotified) return;
		softNotified = true;
		ctx.ui.notify(
			"Session unnamed — /name to auto-name, /name <name> to set one.",
			"info",
		);
	}

	function gatherContext(ctx: { sessionManager: { getBranch(): any[] } }): string {
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
			if (e.type !== "message" || e.message?.role !== "user") continue;

			const content = e.message.content;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) text += `${block.text}\n`;
				}
			}

			if (text.trim()) userMessages.push(text.trim());
		}

		return userMessages.join("\n").slice(0, MAX_CHARS).trim();
	}

	async function resolveModel(ctx: any) {
		if (!hasModel) return null;
		const available = ctx.modelRegistry.getAvailable();
		if (!Array.isArray(available) || available.length === 0) {
			if (!ctx.model) return null;
			const key = await ctx.modelRegistry.getApiKey(ctx.model);
			return key ? { model: ctx.model, apiKey: key } : null;
		}
		const sorted = [...available].sort(
			(a: any, b: any) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity),
		);
		for (const candidate of sorted) {
			const key = await ctx.modelRegistry.getApiKey(candidate);
			if (key) return { model: candidate, apiKey: key };
		}
		return null;
	}

	function sanitizeGeneratedName(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^a-z0-9-\s]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60);
	}

	function computeSuggestedName(ctx: any) {
		const current = api.getSessionName()?.trim();
		if (current) {
			suggestedName = current;
			return;
		}

		const context = gatherContext(ctx);
		opts.captureContext?.(context);

		const raw =
			opts.suggestedResult ??
			opts.structuredResult ??
			opts.autoNameResult ??
			"test-session-name";
		const trimmed = raw.trim().slice(0, 60);
		suggestedName = trimmed || null;
	}

	async function autoName(
		ctx: any,
		options: { ignoreExistingName?: boolean } = {},
	): Promise<void> {
		if (!isActive(ctx, options)) return;

		const context = gatherContext(ctx);
		opts.captureContext?.(context);
		if (!context) return;

		const resolved = await resolveModel(ctx);
		if (!resolved) {
			softNotify(ctx);
			return;
		}

		generating = true;
		try {
			if (opts.autoNameFails) throw new Error("LLM failed");

			const structuredRaw =
				opts.structuredResult ?? opts.autoNameResult ?? "test-session-name";
			const structured = structuredRaw.trim().slice(0, 60);
			if (structured) {
				api.setSessionName(structured);
				markNamed(structured);
				ctx.ui.notify(
					`Auto-named: ${structured}. /name <name> to change.`,
					"info",
				);
				return;
			}

			const fallback = sanitizeGeneratedName(opts.fallbackResult ?? "");
			if (!fallback) {
				softNotify(ctx);
				return;
			}

			api.setSessionName(fallback);
			markNamed(fallback);
			ctx.ui.notify(
				`Auto-named: ${fallback}. /name <name> to change.`,
				"info",
			);
		} catch {
			softNotify(ctx);
		} finally {
			generating = false;
		}
	}

	async function forceAutoName(ctx: any): Promise<void> {
		await autoName(ctx, { ignoreExistingName: true });
		if (!api.getSessionName()) computeSuggestedName(ctx);
	}

	function isBlankNameEditorText(text: string): boolean {
		return text.trim() === "/name";
	}

	function fillNameEditor(ctx: any, name: string) {
		ctx.ui.setEditorText("");
		ctx.ui.pasteToEditor(`/name ${name}`);
	}

	function installTerminalHook(ctx: any) {
		if (!ctx.hasUI) return;
		ctx.ui.onTerminalInput((data: string) => {
			const text = ctx.ui.getEditorText();
			if (!text.startsWith("/name")) return;

			if (data === "\t" && isBlankNameEditorText(text)) {
				const current = api.getSessionName()?.trim();
				if (current) {
					fillNameEditor(ctx, current);
					return { consume: true };
				}

				void (async () => {
					const fallback = suggestedName?.trim() || null;
					computeSuggestedName(ctx);
					const refreshed =
						api.getSessionName()?.trim() || suggestedName?.trim() || fallback;
					if (refreshed && isBlankNameEditorText(ctx.ui.getEditorText())) {
						fillNameEditor(ctx, refreshed);
					}
				})();
				return { consume: true };
			}

			if ((data === "\r" || data === "\n") && isBlankNameEditorText(text)) {
				ctx.ui.setEditorText("");
				void forceAutoName(ctx);
				return { consume: true };
			}
		});
	}

	function resetState(ctx?: any) {
		turnCount = 0;
		softNotified = false;
		generating = false;
		suggestedName = api.getSessionName() ?? null;
		if (ctx?.hasUI) computeSuggestedName(ctx);
	}

	api.on("session_start", async (_event: any, ctx: any) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});
	api.on("session_switch", async (_event: any, ctx: any) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});
	api.on("session_fork", async (_event: any, ctx: any) => {
		installTerminalHook(ctx);
		resetState(ctx);
	});

	api.on("session_compact", async (_event: any, ctx: any) => {
		if (isActive(ctx)) await autoName(ctx);
	});

	api.on("turn_end", async (_event: any, ctx: any) => {
		turnCount++;
		if (turnCount >= HARD && isActive(ctx)) {
			await autoName(ctx);
		} else if (
			turnCount >= SOFT &&
			!softNotified &&
			!api.getSessionName() &&
			ctx.hasUI
		) {
			softNotify(ctx);
		}

		if (!api.getSessionName() && ctx.hasUI) computeSuggestedName(ctx);
	});

	return {
		getTurnCount: () => turnCount,
		getSuggestedName: () => suggestedName,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("truncateSegment", () => {
	it("should return short strings unchanged", () => {
		assert.equal(truncateSegment("hello", 12), "hello");
	});

	it("should truncate at max with ellipsis", () => {
		assert.equal(truncateSegment("very-long-branch-name", 12), "very-long-br…");
	});

	it("should handle exact length", () => {
		assert.equal(truncateSegment("exactly12chr", 12), "exactly12chr");
	});

	it("should handle empty string", () => {
		assert.equal(truncateSegment("", 12), "");
	});

	it("should return null for null input", () => {
		assert.equal(truncateSegment(null, 12), null);
	});
});

describe("detectWorktree", () => {
	it("should detect linked worktree", async () => {
		const exec: ExecFn = async (_cmd, args) => {
			if (args.includes("--show-toplevel")) {
				return { stdout: "/home/user/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--git-common-dir")) {
				return { stdout: "../../main-repo/.git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await detectWorktree("/home/user/.tree/feat-new-app", exec);
		assert.deepEqual(result, { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" });
	});

	it("should detect main worktree (not linked)", async () => {
		const exec: ExecFn = async (_cmd, args) => {
			if (args.includes("--show-toplevel")) {
				return { stdout: "/home/user/main-repo\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--git-common-dir")) {
				return { stdout: ".git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await detectWorktree("/home/user/main-repo", exec);
		assert.deepEqual(result, { isLinkedWorktree: false, worktreeLeaf: null });
	});

	it("should handle non-git directory", async () => {
		const exec: ExecFn = async () => {
			return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
		};
		const result = await detectWorktree("/home/user/plain-dir", exec);
		assert.deepEqual(result, { isLinkedWorktree: false, worktreeLeaf: null });
	});

	it("should handle absolute git-common-dir outside toplevel", async () => {
		const exec: ExecFn = async (_cmd, args) => {
			if (args.includes("--show-toplevel")) {
				return { stdout: "/home/user/.tree/fix-bug\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--git-common-dir")) {
				return { stdout: "/home/user/main-repo/.git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await detectWorktree("/home/user/.tree/fix-bug", exec);
		assert.deepEqual(result, { isLinkedWorktree: true, worktreeLeaf: "fix-bug" });
	});
});

describe("stripBranchPrefix", () => {
	it("should strip feat/ prefix", () => {
		assert.equal(stripBranchPrefix("feat/new-login"), "new-login");
	});

	it("should strip fix/ prefix", () => {
		assert.equal(stripBranchPrefix("fix/broken-auth"), "broken-auth");
	});

	it("should strip pr/ prefix", () => {
		assert.equal(stripBranchPrefix("pr/42-review"), "42-review");
	});

	it("should strip hotfix/ prefix", () => {
		assert.equal(stripBranchPrefix("hotfix/urgent"), "urgent");
	});

	it("should not strip unknown prefixes", () => {
		assert.equal(stripBranchPrefix("release/v2"), "release/v2");
	});

	it("should handle no prefix", () => {
		assert.equal(stripBranchPrefix("my-branch"), "my-branch");
	});
});

describe("stripWorktreePrefix", () => {
	it("should strip feat- prefix from worktree leaf", () => {
		assert.equal(stripWorktreePrefix("feat-new-app"), "new-app");
	});

	it("should strip fix- prefix", () => {
		assert.equal(stripWorktreePrefix("fix-bug"), "bug");
	});

	it("should not strip unknown prefixes", () => {
		assert.equal(stripWorktreePrefix("release-v2"), "release-v2");
	});
});

describe("extractRepoName", () => {
	it("should parse SSH remote URL", () => {
		assert.equal(extractRepoName("git@github.com:org/repo.git"), "repo");
	});

	it("should parse HTTPS remote URL with .git", () => {
		assert.equal(extractRepoName("https://github.com/org/repo.git"), "repo");
	});

	it("should parse HTTPS remote URL without .git", () => {
		assert.equal(extractRepoName("https://github.com/org/repo"), "repo");
	});

	it("should parse SSH protocol URL", () => {
		assert.equal(extractRepoName("ssh://git@github.com/org/repo.git"), "repo");
	});

	it("should return null for empty string", () => {
		assert.equal(extractRepoName(""), null);
	});

	it("should handle URL with trailing whitespace", () => {
		assert.equal(extractRepoName("git@github.com:org/repo.git\n"), "repo");
	});
});

describe("resolveProject", () => {
	it("should extract repo name from git remote", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return {
					stdout: "git@github.com:mitsuhiko/pi-coding-agent.git\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/repo", exec);
		assert.equal(result, "pi-coding-ag…");
	});

	it("should extract short repo name without truncation", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/namenag.git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/repo", exec);
		assert.equal(result, "namenag");
	});

	it("should fall back to cwd basename when no git remote", async () => {
		const exec: ExecFn = async () => {
			return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
		};
		const result = await resolveProject("/home/user/my-project", exec);
		assert.equal(result, "my-project");
	});

	it("should truncate long cwd basename", async () => {
		const exec: ExecFn = async () => {
			return { stdout: "", stderr: "fatal", exitCode: 128 };
		};
		const result = await resolveProject("/home/user/very-long-project-name", exec);
		assert.equal(result, "very-long-pr…");
	});

	it("should handle HTTPS URL without .git suffix", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/my-repo\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/path", exec);
		assert.equal(result, "my-repo");
	});

	it("should handle exec throwing", async () => {
		const exec: ExecFn = async () => {
			throw new Error("nope");
		};
		const result = await resolveProject("/home/user/fallback-dir", exec);
		assert.equal(result, "fallback-dir");
	});
});

describe("resolveWorktreeName", () => {
	it("should return stripped worktree leaf for linked worktree", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
		assert.equal(resolveWorktreeName(wt), "new-app");
	});

	it("should return null for non-linked worktree", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: false, worktreeLeaf: null };
		assert.equal(resolveWorktreeName(wt), null);
	});

	it("should truncate long worktree names", () => {
		const wt: WorktreeInfo = {
			isLinkedWorktree: true,
			worktreeLeaf: "feat-very-long-worktree-name",
		};
		assert.equal(resolveWorktreeName(wt), "very-long-wo…");
	});

	it("should handle worktree leaf without conventional prefix", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "my-feature" };
		assert.equal(resolveWorktreeName(wt), "my-feature");
	});

	it("should handle worktree with null leaf", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: null };
		assert.equal(resolveWorktreeName(wt), null);
	});

	it("should strip fix- prefix", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "fix-auth-bug" };
		assert.equal(resolveWorktreeName(wt), "auth-bug");
	});
});

describe("resolveBranch", () => {
	it("should return stripped branch name", async () => {
		const exec: ExecFn = async (_cmd, args) => {
			if (args.includes("--show-current")) {
				return { stdout: "feat/42-auth-refactor\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, "42-auth-refa…");
	});

	it("should skip main branch", async () => {
		const exec: ExecFn = async () => ({ stdout: "main\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, null);
	});

	it("should skip master branch", async () => {
		const exec: ExecFn = async () => ({ stdout: "master\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, null);
	});

	it("should skip when branch slug matches worktree leaf (both prefix-stripped)", async () => {
		const exec: ExecFn = async () => ({ stdout: "feat/new-app\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, null);
	});

	it("should include branch when different from worktree leaf", async () => {
		const exec: ExecFn = async () => ({ stdout: "pr/7-live-prices\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, "7-live-price…");
	});

	it("should return short branch without truncation", async () => {
		const exec: ExecFn = async () => ({ stdout: "feat/login\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, "login");
	});

	it("should handle git failure gracefully", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, null);
	});

	it("should handle detached HEAD", async () => {
		const exec: ExecFn = async () => ({ stdout: "\n", stderr: "", exitCode: 0 });
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, null);
	});
});

describe("resolvePR", () => {
	it("should return pr<N> on success", async () => {
		const exec: ExecFn = async () => ({ stdout: "42\n", stderr: "", exitCode: 0 });
		const result = await resolvePR("/repo", exec);
		assert.equal(result, "pr42");
	});

	it("should return null when no PR", async () => {
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "no pull requests found",
			exitCode: 1,
		});
		const result = await resolvePR("/repo", exec);
		assert.equal(result, null);
	});

	it("should return null on timeout (simulated via rejection)", async () => {
		const exec: ExecFn = async () => {
			throw new Error("timed out");
		};
		const result = await resolvePR("/repo", exec);
		assert.equal(result, null);
	});

	it("should return null when gh not installed", async () => {
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "command not found: gh",
			exitCode: 127,
		});
		const result = await resolvePR("/repo", exec);
		assert.equal(result, null);
	});

	it("should return null for non-numeric output", async () => {
		const exec: ExecFn = async () => ({ stdout: "not-a-number\n", stderr: "", exitCode: 0 });
		const result = await resolvePR("/repo", exec);
		assert.equal(result, null);
	});

	it("should pass 3s timeout to exec", async () => {
		let capturedTimeout: number | undefined;
		const exec: ExecFn = async (_cmd, _args, opts) => {
			capturedTimeout = opts?.timeout;
			return { stdout: "7\n", stderr: "", exitCode: 0 };
		};
		await resolvePR("/repo", exec);
		assert.equal(capturedTimeout, 3000);
	});
});

describe("resolveSubfolder", () => {
	it("should return null when at project root", async () => {
		const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
		const result = await resolveSubfolder("/home/user/project", exec);
		assert.equal(result, null);
	});

	it("should return slugified relative path for nested cwd", async () => {
		const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
		const result = await resolveSubfolder("/home/user/project/pkg/worker", exec);
		assert.equal(result, "pkg-worker");
	});

	it("should truncate long subfolder paths", async () => {
		const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
		const result = await resolveSubfolder("/home/user/project/packages/very-long-name/src", exec);
		assert.equal(result, "packages-ver…");
	});

	it("should return null for non-git directory (no project.org fallback in tests)", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
		const result = await resolveSubfolder("/home/user/plain-dir/sub", exec);
		assert.equal(result, null);
	});

	it("should handle single-level nesting", async () => {
		const exec: ExecFn = async () => ({ stdout: "/repo\n", stderr: "", exitCode: 0 });
		const result = await resolveSubfolder("/repo/src", exec);
		assert.equal(result, "src");
	});
});

describe("assembleSegments", () => {
	it("should join all segments with colon", () => {
		const result = assembleSegments(["42-auth", "pr42", "pkg-worker", "token-handler"]);
		assert.equal(result, "42-auth:pr42:pkg-worker:token-handler");
	});

	it("should handle 6-segment structured name", () => {
		const result = assembleSegments([
			"myproj",
			"new-app",
			"42-auth",
			"pr42",
			"pkg-worker",
			"token-handler",
		]);
		assert.equal(result, "myproj:new-app:42-auth:pr42:pkg-worker:token-handler");
	});

	it("should filter null project and worktree segments", () => {
		const result = assembleSegments([null, null, "42-auth", "pr42", null, "ordering-fix"]);
		assert.equal(result, "42-auth:pr42:ordering-fix");
	});

	it("should filter null segments", () => {
		const result = assembleSegments([null, "pr42", null, "ordering-fix"]);
		assert.equal(result, "pr42:ordering-fix");
	});

	it("should filter empty string segments", () => {
		const result = assembleSegments(["", "pr42", "", "review"]);
		assert.equal(result, "pr42:review");
	});

	it("should return empty string when all segments are null", () => {
		const result = assembleSegments([null, null, null, null]);
		assert.equal(result, "");
	});

	it("should handle single segment", () => {
		const result = assembleSegments([null, null, null, "debug-cache"]);
		assert.equal(result, "debug-cache");
	});

	it("should handle mixed null and empty", () => {
		const result = assembleSegments([null, "", null, ""]);
		assert.equal(result, "");
	});
});

describe("resolveDescription", () => {
	it("should return LLM-generated description", async () => {
		const llm = async (_context: string) => "refactor-auth";
		const result = await resolveDescription("Help me refactor auth", llm);
		assert.equal(result, "refactor-auth");
	});

	it("should truncate long descriptions at 20 chars", async () => {
		const llm = async () => "very-long-description-name";
		const result = await resolveDescription("context", llm);
		assert.equal(result, "very-long-descriptio…");
	});

	it("should sanitize LLM output to kebab-case", async () => {
		const llm = async () => '"Refactor Auth Module!"';
		const result = await resolveDescription("context", llm);
		assert.equal(result, "refactor-auth-module");
	});

	it("should return null on LLM failure", async () => {
		const llm = async () => {
			throw new Error("LLM failed");
		};
		const result = await resolveDescription("context", llm);
		assert.equal(result, null);
	});

	it("should return null on empty LLM response", async () => {
		const llm = async () => "";
		const result = await resolveDescription("context", llm);
		assert.equal(result, null);
	});

	it("should return null on empty context", async () => {
		const llm = async () => "should-not-reach";
		const result = await resolveDescription("", llm);
		assert.equal(result, null);
	});
});

describe("structuredName", () => {
	it("should produce full structured name with all segments", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("--show-toplevel")) {
				return { stdout: "/home/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--git-common-dir")) {
				return { stdout: "/home/main/.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--show-current")) {
				return { stdout: "pr/7-live-prices\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "git@github.com:org/myproj.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "70\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "review-triage";

		const result = await structuredName("/home/.tree/feat-new-app", exec, "context", llm);
		assert.equal(result, "myproj:new-app:7-live-price…:pr70:review-triage");
	});

	it("should produce description-only when on main with no PR", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (args.includes("--show-toplevel")) {
				return { stdout: "/repo\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--git-common-dir")) {
				return { stdout: ".git\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--show-current")) {
				return { stdout: "main\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "", stderr: "no PR", exitCode: 1 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "debug-worker-cache";

		const result = await structuredName("/repo", exec, "context", llm);
		assert.equal(result, "myrepo:debug-worker-cache");
	});

	it("should return project-only when all other resolvers fail", async () => {
		const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
		const llm = async () => {
			throw new Error("fail");
		};

		const result = await structuredName("/no-git", exec, "", llm);
		assert.equal(result, "no-git");
	});

	it("should include subfolder when in subdirectory", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (args.includes("--show-toplevel")) {
				return { stdout: "/repo\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--git-common-dir")) {
				return { stdout: ".git\n", stderr: "", exitCode: 0 };
			}
			if (args.includes("--show-current")) {
				return { stdout: "main\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "70\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "cache-refactor";

		const result = await structuredName("/repo/pkg/worker", exec, "context", llm);
		assert.equal(result, "myrepo:pr70:pkg-worker:cache-refactor");
	});
});

describe("structured naming integration", () => {
	it("should produce project:branch:pr:description for feature branch with PR", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("--show-toplevel")) {
				return { stdout: "/repo\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--git-common-dir")) {
				return { stdout: ".git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--show-current")) {
				return { stdout: "feat/42-auth-refactor\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "42\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "token-handler";

		const result = await structuredName("/repo", exec, "context", llm);
		assert.equal(result, "myrepo:42-auth-refa…:pr42:token-handler");
	});

	it("should produce project:worktree:pr:subfolder:description when branch matches worktree", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("--show-toplevel")) {
				return { stdout: "/home/user/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--git-common-dir")) {
				return { stdout: "/home/user/main/.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--show-current")) {
				return { stdout: "feat/new-app\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "git@github.com:org/myproj.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "70\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "cache-refactor";

		const result = await structuredName("/home/user/.tree/feat-new-app/pkg/worker", exec, "context", llm);
		assert.equal(result, "myproj:new-app:pr70:pkg-worker:cache-refactor");
	});

	it("should produce project:description on main without PR", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("--show-toplevel")) {
				return { stdout: "/repo\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--git-common-dir")) {
				return { stdout: ".git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("--show-current")) {
				return { stdout: "main\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
			}
			if (cmd === "gh") {
				return { stdout: "", stderr: "no pull request", exitCode: 1 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const llm = async () => "debug-worker-cache";

		const result = await structuredName("/repo", exec, "context", llm);
		assert.equal(result, "myrepo:debug-worker-cache");
	});

	it("should use project basename when no git and description fails", async () => {
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "fatal: not a git repository",
			exitCode: 128,
		});
		const llm = async () => {
			throw new Error("description failed");
		};
		const result = await structuredName("/plain-dir", exec, "context", llm);
		assert.equal(result, "plain-dir");
	});
});

describe("fallback behavior", () => {
	it("should use old-style LLM when structured name is empty", async () => {
		const mock = createMockPi();
		registerTestHandlers(mock.api, {
			structuredResult: "",
			fallbackResult: "legacy-fallback-name",
		});
		await mock.fire("session_start");
		await mock.fire("session_compact");

		assert.equal(mock.getSessionName(), "legacy-fallback-name");
	});

	it("should soft-notify when both structured and fallback fail", async () => {
		const mock = createMockPi();
		registerTestHandlers(mock.api, {
			structuredResult: "",
			fallbackResult: "",
		});
		await mock.fire("session_start");
		await mock.fire("session_compact");

		assert.equal(mock.getSessionName(), undefined);
		assert.ok(mock.notifications.some((n) => n.message.includes("Session unnamed")));
	});
});

describe("/name vs auto-triggers", () => {
	it("auto-trigger (compaction) should NOT overwrite existing name", async () => {
		const mock = createMockPi();
		mock.setSessionName("existing-name");
		registerTestHandlers(mock.api, { structuredResult: "should-not-apply" });
		await mock.fire("session_start");

		await mock.fire("session_compact");

		assert.equal(mock.getSessionName(), "existing-name");
	});

	it("/name with no args SHOULD overwrite existing name", async () => {
		const mock = createMockPi();
		mock.setSessionName("existing-name");
		registerTestHandlers(mock.api, { structuredResult: "forced-new-name" });
		await mock.fire("session_start");
		mock.setEditorText("/name");

		const result = mock.sendTerminalInput("\r");
		await flushAsync();

		assert.equal(result?.consume, true);
		assert.equal(mock.getSessionName(), "forced-new-name");
		assert.equal(mock.getEditorText(), "");
	});
});

describe("segment edge cases", () => {
	it("short branch should fit without truncation", async () => {
		const exec: ExecFn = async (_cmd, args) => {
			if (args.includes("--show-current")) {
				return { stdout: "feat/42-auth\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "fatal", exitCode: 1 };
		};
		const wt = { isLinkedWorktree: false, worktreeLeaf: null };
		const result = await resolveBranch("/repo", exec, wt);
		assert.equal(result, "42-auth");
	});

	it("PR numbers should stay naturally short", async () => {
		const exec: ExecFn = async () => ({ stdout: "7\n", stderr: "", exitCode: 0 });
		const result = await resolvePR("/repo", exec);
		assert.equal(result, "pr7");
	});

	it("deeply nested subfolder should truncate with ellipsis", async () => {
		const exec: ExecFn = async () => ({ stdout: "/repo\n", stderr: "", exitCode: 0 });
		const result = await resolveSubfolder("/repo/packages/deep/nested/path/module", exec);
		assert.equal(result, "packages-dee…");
	});
});

describe("namenag", () => {
	describe("state initialization", () => {
		it("should not nag if session already has a name on start", async () => {
			const mock = createMockPi();
			mock.setSessionName("existing-name");
			registerTestHandlers(mock.api);

			await mock.fire("session_start");

			for (let i = 0; i < 15; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.notifications.length, 0, "Should not nag when already named");
		});

		it("should reset state on session_switch", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);

			await mock.fire("session_start");

			for (let i = 0; i < 8; i++) {
				await mock.fire("turn_end");
			}

			mock.setSessionName("new-session");
			await mock.fire("session_switch");

			for (let i = 0; i < 15; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.notifications.length, 0, "Should not nag after switch to named session");
		});

		it("should reset state on session_fork", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);

			await mock.fire("session_start");

			for (let i = 0; i < 12; i++) {
				await mock.fire("turn_end");
			}

			const softCount = mock.notifications.length;
			assert.ok(softCount > 0, "Should have soft notification");

			mock.setSessionName("forked-session");
			await mock.fire("session_fork");

			for (let i = 0; i < 15; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.notifications.length, softCount, "No new notifications after fork to named session");
		});
	});

	describe("context gathering", () => {
		it("should use last 3 user messages in most-recent-first order", async () => {
			const mock = createMockPi();
			mock.ctx.sessionManager.getBranch = () => [
				{
					type: "message",
					message: { role: "user", content: "oldest user" },
				},
				{
					type: "message",
					message: { role: "assistant", content: "ignored" },
				},
				{
					type: "message",
					message: { role: "user", content: "middle user" },
				},
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "newer user" }],
					},
				},
				{
					type: "message",
					message: { role: "user", content: "latest user" },
				},
			];

			let capturedContext = "";
			registerTestHandlers(mock.api, {
				autoNameResult: "context-test",
				captureContext: (context: string) => {
					capturedContext = context;
				},
			});

			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(capturedContext, "latest user\nnewer user\nmiddle user");
		});

		it("should cap gathered context at 500 chars", async () => {
			const mock = createMockPi();
			const newest = "c".repeat(250);
			const middle = "b".repeat(250);
			const older = "a".repeat(250);
			mock.ctx.sessionManager.getBranch = () => [
				{ type: "message", message: { role: "user", content: older } },
				{ type: "message", message: { role: "user", content: middle } },
				{ type: "message", message: { role: "user", content: newest } },
			];

			let capturedContext = "";
			registerTestHandlers(mock.api, {
				autoNameResult: "context-test",
				captureContext: (context: string) => {
					capturedContext = context;
				},
			});

			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(capturedContext.length, 500);
			assert.ok(capturedContext.startsWith(newest));
			assert.ok(!capturedContext.includes("a"));
		});
	});

	describe("structured pipeline wiring", () => {
		it("should keep colon-separated structured names", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, {
				structuredResult: "branch:pr42:pkg-worker:debug-cache",
			});
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), "branch:pr42:pkg-worker:debug-cache");
		});

		it("should fall back to old-style name when structured result is empty", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, {
				structuredResult: "",
				fallbackResult: "fallback-session-name",
			});
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), "fallback-session-name");
		});

		it("should soft-notify when structured and fallback are both empty", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, {
				structuredResult: "",
				fallbackResult: "",
			});
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), undefined);
			assert.ok(mock.notifications.some((n) => n.message.includes("Session unnamed")));
		});
	});

	describe("/name terminal interception", () => {
		it("should not register a conflicting name command", () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);

			assert.ok(!mock.commands.has("name"));
		});

		it("should intercept enter for blank /name", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { structuredResult: "forced-rename" });
			await mock.fire("session_start");
			mock.setEditorText("/name ");

			const result = mock.sendTerminalInput("\r");
			await flushAsync();

			assert.equal(result?.consume, true);
			assert.equal(mock.getSessionName(), "forced-rename");
			assert.equal(mock.getEditorText(), "");
		});

		it("should leave explicit /name arguments for the built-in handler", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { structuredResult: "ignored-auto-name" });
			await mock.fire("session_start");
			mock.setEditorText("/name manual-name");

			const result = mock.sendTerminalInput("\r");
			await flushAsync();

			assert.equal(result, undefined);
			assert.equal(mock.getSessionName(), undefined);
			assert.equal(mock.getEditorText(), "/name manual-name");
		});

		it("should tab-fill with the current session name", async () => {
			const mock = createMockPi();
			mock.setSessionName("existing-name");
			registerTestHandlers(mock.api);
			await mock.fire("session_start");
			mock.setEditorText("/name ");

			const result = mock.sendTerminalInput("\t");

			assert.equal(result?.consume, true);
			assert.equal(mock.getEditorText(), "/name existing-name");
		});

		it("should tab-fill with a suggested name when unnamed", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { suggestedResult: "project:branch:suggested" });
			await mock.fire("session_start");
			mock.setEditorText("/name ");

			const result = mock.sendTerminalInput("\t");

			assert.equal(result?.consume, true);
			assert.equal(mock.getEditorText(), "/name project:branch:suggested");
		});

		it("should consume tab for blank /name even before suggestion is ready", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { suggestedResult: "project:branch:suggested" });
			await mock.fire("session_start");
			mock.setEditorText("/name");

			const result = mock.sendTerminalInput("\t");
			await flushAsync();

			assert.equal(result?.consume, true);
			assert.equal(mock.getEditorText(), "/name project:branch:suggested");
		});
	});

	describe("soft trigger (≥10 turns)", () => {
		it("should notify at 10 turns", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);
			await mock.fire("session_start");

			for (let i = 0; i < 10; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.notifications.length, 1, "Should notify exactly once at 10 turns");
			assert.ok(
				mock.notifications[0].message.includes("/name"),
				"Notification should mention /name command",
			);
		});

		it("should not re-notify on subsequent turns", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);
			await mock.fire("session_start");

			for (let i = 0; i < 30; i++) {
				await mock.fire("turn_end");
			}

			const softNotifs = mock.notifications.filter((n) =>
				n.message.includes("Session unnamed"),
			);
			assert.equal(softNotifs.length, 1, "Soft notification should fire exactly once");
		});

		it("should not notify before 10 turns", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api);
			await mock.fire("session_start");

			for (let i = 0; i < 9; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.notifications.length, 0, "No notification before threshold");
		});
	});

	describe("hard trigger (≥50 turns)", () => {
		it("should auto-name at 50 turns", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameResult: "refactor-auth-module" });
			await mock.fire("session_start");

			for (let i = 0; i < 50; i++) {
				await mock.fire("turn_end");
			}

			assert.equal(mock.getSessionName(), "refactor-auth-module", "Should auto-name at 50 turns");
			const autoNotifs = mock.notifications.filter((n) =>
				n.message.includes("Auto-named"),
			);
			assert.equal(autoNotifs.length, 1, "Should notify about auto-naming");
		});

		it("should not auto-name again after naming", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameResult: "refactor-auth-module" });
			await mock.fire("session_start");

			for (let i = 0; i < 100; i++) {
				await mock.fire("turn_end");
			}

			const autoNotifs = mock.notifications.filter((n) =>
				n.message.includes("Auto-named"),
			);
			assert.equal(autoNotifs.length, 1, "Should auto-name only once");
		});
	});

	describe("hard trigger (compaction)", () => {
		it("should auto-name on compaction", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameResult: "shaping-session-naming" });
			await mock.fire("session_start");

			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), "shaping-session-naming");
			assert.ok(
				mock.notifications.some((n) => n.message.includes("Auto-named")),
				"Should notify about auto-naming on compaction",
			);
		});

		it("should not auto-name on compaction if already named", async () => {
			const mock = createMockPi();
			mock.setSessionName("already-named");
			registerTestHandlers(mock.api, { autoNameResult: "should-not-appear" });
			await mock.fire("session_start");

			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), "already-named", "Name should not change");
			assert.equal(mock.notifications.length, 0, "No notifications");
		});
	});

	describe("hasUI guard", () => {
		it("should not notify or auto-name when hasUI is false", async () => {
			const mock = createMockPi();
			mock.ctx.hasUI = false;
			registerTestHandlers(mock.api);
			await mock.fire("session_start");

			for (let i = 0; i < 60; i++) {
				await mock.fire("turn_end");
			}
			await mock.fire("session_compact");

			assert.equal(mock.notifications.length, 0, "No notifications without UI");
			assert.equal(mock.getSessionName(), undefined, "No name set without UI");
		});
	});

	describe("name sanitization", () => {
		it("should sanitize fallback LLM output to kebab-case", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, {
				structuredResult: "",
				fallbackResult: '  "Refactor Auth Module!"  ',
			});
			await mock.fire("session_start");
			await mock.fire("session_compact");

			const name = mock.getSessionName();
			assert.ok(name, "Should have a name");
			assert.match(name!, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Should be clean kebab-case");
			assert.ok(!name!.includes('"'), "No quotes");
			assert.ok(!name!.includes("!"), "No special chars");
		});

		it("should handle empty LLM response gracefully", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameResult: "" });
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), undefined, "No name from empty response");
			assert.ok(
				mock.notifications.some((n) => n.message.includes("Session unnamed")),
				"Should fall back to soft notify",
			);
		});
	});

	describe("LLM failure fallback", () => {
		it("should fall back to soft notify when LLM fails", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameFails: true });
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), undefined, "No name on failure");
			assert.ok(
				mock.notifications.some((n) => n.message.includes("Session unnamed")),
				"Should soft-notify on failure",
			);
		});
	});

	describe("model resolution", () => {
		it("should pick cheapest available model", async () => {
			const mock = createMockPi();
			let resolvedModel: any = null;

			// Intercept to check which model gets picked
			const origGetApiKey = mock.ctx.modelRegistry.getApiKey;
			mock.ctx.modelRegistry.getApiKey = async (model: any) => {
				resolvedModel = model;
				return origGetApiKey(model);
			};

			registerTestHandlers(mock.api, { autoNameResult: "test-name" });
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(resolvedModel?.id, "test-cheap", "Should resolve cheapest model");
		});

		it("should fall back to soft notify when no models available", async () => {
			const mock = createMockPi({ hasModel: false });
			registerTestHandlers(mock.api, { hasModel: false });
			await mock.fire("session_start");
			await mock.fire("session_compact");

			assert.equal(mock.getSessionName(), undefined, "No name without models");
			assert.ok(
				mock.notifications.some((n) => n.message.includes("Session unnamed")),
				"Should soft-notify when no models",
			);
		});
	});

});
