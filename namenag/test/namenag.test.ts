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
import { detectWorktree, type ExecFn, truncateSegment } from "../resolve.js";

// ─── Minimal Mock Harness ────────────────────────────────────────────────────

interface Notification {
	message: string;
	level: string;
}

type Handler = (event: any, ctx: any) => Promise<void>;

function createMockPi(opts: { hasModel?: boolean } = {}) {
	const handlers: Record<string, Handler[]> = {};
	const notifications: Notification[] = [];
	let sessionName: string | undefined;

	const ui = {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		theme: { fg: (_style: string, text: string) => text },
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

	const api: any = {
		on(event: string, handler: Handler) {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
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
	};
}

// ─── Test harness: register handlers that mirror the extension ───────────────

/**
 * Registers event handlers that mirror namenag.ts logic but with injectable
 * LLM behavior. This lets us test the full event flow without ESM mocking.
 */
function registerTestHandlers(
	api: any,
	opts: { autoNameResult?: string; autoNameFails?: boolean; hasModel?: boolean } = {},
) {
	const SOFT = 10;
	const HARD = 50;
	const hasModel = opts.hasModel ?? true;

	let turnCount = 0;
	let named = false;
	let softNotified = false;
	let generating = false;

	function isActive(ctx: { hasUI: boolean }) {
		return ctx.hasUI && !named && !generating;
	}

	function markNamed() {
		named = true;
		softNotified = true;
	}

	function softNotify(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI || named || softNotified) return;
		softNotified = true;
		ctx.ui.notify("Session unnamed — /name <name> to set one.", "info");
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

	async function autoName(ctx: any): Promise<void> {
		if (!isActive(ctx)) return;

		const resolved = await resolveModel(ctx);
		if (!resolved) {
			softNotify(ctx);
			return;
		}

		generating = true;
		try {
			if (opts.autoNameFails) throw new Error("LLM failed");

			const raw = opts.autoNameResult ?? "test-session-name";

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

			api.setSessionName(name);
			markNamed();
			ctx.ui.notify(`Auto-named: ${name}. /name to change.`, "info");
		} catch {
			softNotify(ctx);
		} finally {
			generating = false;
		}
	}

	function resetState() {
		turnCount = 0;
		softNotified = false;
		generating = false;
		named = !!api.getSessionName();
	}

	api.on("session_start", async () => resetState());
	api.on("session_switch", async () => resetState());
	api.on("session_fork", async () => resetState());

	api.on("session_compact", async (_event: any, ctx: any) => {
		if (isActive(ctx)) await autoName(ctx);
	});

	api.on("turn_end", async (_event: any, ctx: any) => {
		turnCount++;
		if (turnCount >= HARD && isActive(ctx)) {
			await autoName(ctx);
		} else if (turnCount >= SOFT && !softNotified && !named && ctx.hasUI) {
			softNotify(ctx);
		}
	});

	return { getTurnCount: () => turnCount, isNamed: () => named };
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
		it("should sanitize LLM output to kebab-case", async () => {
			const mock = createMockPi();
			registerTestHandlers(mock.api, { autoNameResult: '  "Refactor Auth Module!"  ' });
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
