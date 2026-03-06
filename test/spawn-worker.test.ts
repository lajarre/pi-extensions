import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

function ensureModuleStub(specifier: string, source: string): void {
	const modulePath = path.join(process.cwd(), "node_modules", ...specifier.split("/"));
	fs.mkdirSync(modulePath, { recursive: true });
	fs.writeFileSync(
		path.join(modulePath, "package.json"),
		JSON.stringify(
			{
				name: specifier,
				version: "0.0.0-test",
				main: "index.js",
			},
			null,
			2,
		),
	);
	fs.writeFileSync(path.join(modulePath, "index.js"), source);
}

ensureModuleStub(
	"@mariozechner/pi-ai",
	[
		"exports.StringEnum = function StringEnum(values) {",
		"  return { type: 'string', enum: values };",
		"};",
	].join("\n"),
);

ensureModuleStub(
	"@sinclair/typebox",
	[
		"exports.Type = {",
		"  Object: (properties) => ({ type: 'object', properties }),",
		"  Optional: (schema) => ({ ...schema, optional: true }),",
		"  String: () => ({ type: 'string' }),",
		"};",
	].join("\n"),
);

let buildSplitArgs: any;
let buildWorkerLaunchCommand: any;
let loadState: any;
let parseSpawnCommandArgs: any;
let parseSpawnToolArgs: any;
let runSpawnWorker: any;
let sanitizeSuffix: any;
let sessionDirMode: any;
let warnOnDrift: any;
let resolveSessionDirForChild: any;
let spawnWorkerExtension: any;

before(async () => {
	const spawn = await import("../spawn-worker.ts");
	({
		buildSplitArgs,
		buildWorkerLaunchCommand,
		loadState,
		parseSpawnCommandArgs,
		parseSpawnToolArgs,
		runSpawnWorker,
		sanitizeSuffix,
		sessionDirMode,
		warnOnDrift,
		resolveSessionDirForChild,
		default: spawnWorkerExtension,
	} = spawn);
});

interface ExecCall {
	command: string;
	args: string[];
}

interface Note {
	message: string;
	level: string;
}

function tmuxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		TMUX: "test-tmux",
		TMUX_PANE: "%9",
		...overrides,
	};
}

function createHarness(options: {
	sessionName?: string;
	branch?: any[];
	sessionDir?: string;
	splitPaneId?: string;
} = {}) {
	const branch = [...(options.branch ?? [])];
	const execCalls: ExecCall[] = [];
	const notifications: Note[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	let tool: any;
	let currentSessionName = options.sessionName;
	const setSessionNameCalls: string[] = [];

	const ctx = {
		cwd: "/tmp/pi-extensions",
		hasUI: true,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			getBranch() {
				return branch;
			},
			getSessionDir() {
				return options.sessionDir;
			},
		},
	};

	const api = {
		on(event: string, handler: (event: any, ctx: any) => Promise<void>) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		registerTool(definition: any) {
			tool = definition;
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args: [...args] });
			if (command !== "tmux") {
				return { code: 127, stdout: "", stderr: `Unexpected command ${command}` };
			}

			if (args[0] === "-V") {
				return { code: 0, stdout: "tmux 3.4\n", stderr: "" };
			}

			if (args[0] === "split-window") {
				return {
					code: 0,
					stdout: `${options.splitPaneId ?? "%42"}\n`,
					stderr: "",
				};
			}

			if (args[0] === "send-keys") {
				return { code: 0, stdout: "", stderr: "" };
			}

			return { code: 1, stdout: "", stderr: "unknown tmux call" };
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		getSessionName() {
			return currentSessionName;
		},
		setSessionName(name: string) {
			setSessionNameCalls.push(name);
			currentSessionName = name;
		},
	};

	return {
		api,
		ctx,
		branch,
		execCalls,
		notifications,
		commands,
		getTool: () => tool,
		setSessionName(name: string | undefined) {
			currentSessionName = name;
		},
		setSessionNameCalls,
		async fire(event: string, payload: any = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function assertSuccess(result: any): asserts result is { ok: true; childName: string } {
	assert.equal(result.ok, true, `spawn failed unexpectedly: ${result.error}`);
}

async function withEnv(
	env: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const before = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		before.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		await run();
	} finally {
		for (const [key, value] of before.entries()) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function unwrapSpawnModule(moduleValue: any): any {
	if (moduleValue?.resolveSessionDirForChild) {
		return moduleValue;
	}

	if (moduleValue?.default?.resolveSessionDirForChild) {
		return moduleValue.default;
	}

	return moduleValue;
}

async function importSpawnVariant(mode: "default" | "inherit"): Promise<any> {
	const sourcePath = path.join(process.cwd(), "spawn-worker.ts");
	const source = fs.readFileSync(sourcePath, "utf8");
	const marker = 'export const sessionDirMode: SessionDirMode = "default";';
	assert.ok(source.includes(marker), "sessionDirMode marker missing");

	const piAiUrl = pathToFileURL(
		path.join(
			process.cwd(),
			"node_modules",
			"@mariozechner",
			"pi-ai",
			"index.js",
		),
	).href;
	const typeboxUrl = pathToFileURL(
		path.join(
			process.cwd(),
			"node_modules",
			"@sinclair",
			"typebox",
			"index.js",
		),
	).href;

	const rewritten = source
		.replace(marker, `export const sessionDirMode: SessionDirMode = "${mode}";`)
		.replace(
			'import { StringEnum } from "@mariozechner/pi-ai";',
			`import { StringEnum } from "${piAiUrl}";`,
		)
		.replace(
			'import { Type } from "@sinclair/typebox";',
			`import { Type } from "${typeboxUrl}";`,
		);

	assert.notEqual(rewritten, source, "failed to rewrite spawn-worker variant");

	const variantDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "spawn-worker-session-dir-mode-"),
	);
	const variantPath = path.join(variantDir, `spawn-worker-${mode}.ts`);
	fs.writeFileSync(variantPath, rewritten, "utf8");

	const imported = await import(
		`${pathToFileURL(variantPath).href}?cacheBust=${Date.now()}`,
	);
	return unwrapSpawnModule(imported);
}

describe("1) parser rules for /spawn [suffix] [v|h]", () => {
	it("handles no args, one arg, and two args", () => {
		assert.deepEqual(parseSpawnCommandArgs(""), { split: "v" });
		assert.deepEqual(parseSpawnCommandArgs("h"), { split: "h" });
		assert.deepEqual(parseSpawnCommandArgs("api"), { suffix: "api", split: "v" });
		assert.deepEqual(parseSpawnCommandArgs("api h"), { suffix: "api", split: "h" });
	});

	it("rejects invalid split or too many args", () => {
		assert.throws(() => parseSpawnCommandArgs("api x"), /Invalid split argument/);
		assert.throws(() => parseSpawnCommandArgs("a b c"), /Usage: \/spawn/);
	});
});

describe("2) tool parameter parity with command", () => {
	it("parses equivalent command and tool shapes to same request", () => {
		const pairs: Array<{ command: string; tool: { suffix?: string; split?: "v" | "h" } }> = [
			{ command: "", tool: {} },
			{ command: "v", tool: { split: "v" } },
			{ command: "h", tool: { split: "h" } },
			{ command: "api", tool: { suffix: "api" } },
			{ command: "api h", tool: { suffix: "api", split: "h" } },
		];

		for (const pair of pairs) {
			assert.deepEqual(parseSpawnCommandArgs(pair.command), parseSpawnToolArgs(pair.tool));
		}
	});

	it("wires /spawn command and spawn_worker tool", async () => {
		await withEnv(
			{
				TMUX: "wire-tmux",
				TMUX_PANE: "%5",
				PI_WORKER_MANAGED: undefined,
				PI_WORKER_NAME: undefined,
				PI_WORKER_NAMESPACE: undefined,
				PI_WORKER_SLOT: undefined,
			},
			async () => {
				const commandHarness = createHarness({ sessionName: "parent" });
				spawnWorkerExtension(commandHarness.api as any);
				const spawnCommand = commandHarness.commands.get("spawn");
				assert.ok(spawnCommand);
				await spawnCommand!.handler("api h", commandHarness.ctx);
				assert.ok(
					commandHarness.notifications.some((n) => n.message.includes("parent:api")),
				);

				const toolHarness = createHarness({ sessionName: "parent" });
				spawnWorkerExtension(toolHarness.api as any);
				const tool = toolHarness.getTool();
				assert.ok(tool);
				const toolResult = await tool.execute(
					"call-1",
					{ suffix: "api", split: "h" },
					undefined,
					() => {},
					toolHarness.ctx,
				);
				assert.equal(toolResult.details.ok, true);
				assert.equal(toolResult.details.childName, "parent:api");
			},
		);
	});
});

describe("3) frozen namespace", () => {
	it("captures namespace once and reuses after parent rename", async () => {
		const harness = createHarness({ sessionName: "parent" });

		const first = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(first);
		assert.equal(first.childName, "parent:wrkr-1");

		harness.setSessionName("renamed-parent");
		const second = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(second);
		assert.equal(second.childName, "parent:wrkr-2");
	});
});

describe("4) persisted slot counter across resume", () => {
	it("increments every spawn and survives reloading state", async () => {
		const firstSession = createHarness({ sessionName: "root" });

		const one = await runSpawnWorker(
			firstSession.api as any,
			firstSession.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(one);
		const two = await runSpawnWorker(
			firstSession.api as any,
			firstSession.ctx as any,
			{ split: "v", suffix: "api" },
			tmuxEnv(),
		);
		assertSuccess(two);

		assert.deepEqual(loadState(firstSession.ctx as any), {
			workerNamespace: "root",
			nextSlot: 3,
		});

		const resumed = createHarness({
			sessionName: "any-new-name",
			branch: firstSession.branch,
		});
		const three = await runSpawnWorker(
			resumed.api as any,
			resumed.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(three);
		assert.equal(three.childName, "root:wrkr-3");
	});
});

describe("5) auto naming and suffix naming", () => {
	it("uses wrkr slots for auto and namespace:suffix for custom", async () => {
		const harness = createHarness({ sessionName: "proj" });

		const auto = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(auto);
		assert.equal(auto.childName, "proj:wrkr-1");

		const custom = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v", suffix: "api" },
			tmuxEnv(),
		);
		assertSuccess(custom);
		assert.equal(custom.childName, "proj:api");
	});
});

describe("6) suffix sanitization", () => {
	it("keeps allowed chars", () => {
		assert.equal(sanitizeSuffix("api.v1:_-ok"), "api.v1:_-ok");
	});

	it("maps invalid chars, collapses dashes, trims edges", () => {
		assert.equal(sanitizeSuffix("  api   worker !! "), "api-worker");
		assert.equal(sanitizeSuffix("---alpha###beta---"), "alpha-beta");
	});

	it("caps at 64 chars", () => {
		const long = "a".repeat(80);
		assert.equal(sanitizeSuffix(long).length, 64);
	});

	it("rejects empty-after-sanitize", () => {
		assert.throws(() => sanitizeSuffix("###"), /empty after sanitization/i);
	});
});

describe("7) tmux split args", () => {
	it("uses -v/-h and always detached", () => {
		assert.deepEqual(buildSplitArgs("v", tmuxEnv()), [
			"split-window",
			"-t",
			"%9",
			"-d",
			"-v",
			"-P",
			"-F",
			"#{pane_id}",
		]);

		assert.deepEqual(buildSplitArgs("h", { TMUX: "x" }), [
			"split-window",
			"-d",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
	});
});

describe("8) child launch payload", () => {
	it("includes --session-control and PI_WORKER_* env", async () => {
		const harness = createHarness({ sessionName: "ops" });

		const result = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "h" },
			tmuxEnv(),
		);
		assertSuccess(result);

		const send = harness.execCalls.find((call) => call.args[0] === "send-keys");
		assert.ok(send);
		const launch = send!.args[3];
		assert.match(launch, /PI_WORKER_NAME='ops:wrkr-1'/);
		assert.match(launch, /PI_WORKER_NAMESPACE='ops'/);
		assert.match(launch, /PI_WORKER_SLOT='1'/);
		assert.match(launch, /PI_WORKER_MANAGED=1/);
		assert.match(launch, /pi --session-control/);
	});

	it("command builder includes session-dir only when provided", () => {
		const without = buildWorkerLaunchCommand({
			cwd: "/repo",
			childName: "n:wrkr-1",
			namespace: "n",
			slot: 1,
		});
		assert.ok(!without.includes("--session-dir"));

		const withSessionDir = buildWorkerLaunchCommand({
			cwd: "/repo",
			childName: "n:wrkr-1",
			namespace: "n",
			slot: 1,
			sessionDir: "/tmp/sessions",
		});
		assert.match(withSessionDir, /--session-dir '\/tmp\/sessions'/);
	});
});

describe("9) parent-name precondition", () => {
	it("fails with /name guidance when parent is unnamed", async () => {
		const harness = createHarness();
		const result = await runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assert.equal(result.ok, false);
		assert.match(result.error, /Set a parent name first via \/name <name>/);
	});
});

describe("10) session-dir policy", () => {
	it("keeps v1 default and omits inherited dir unless provided", () => {
		assert.equal(sessionDirMode, "default");
		const ctx = {
			sessionManager: {
				getSessionDir: () => "/tmp/parent-session-dir",
			},
		};
		assert.equal(resolveSessionDirForChild(ctx as any), undefined);
	});

	it("covers inherit policy path with parent session dir", async () => {
		const inheritSpawn = await importSpawnVariant("inherit");
		assert.equal(inheritSpawn.sessionDirMode, "inherit");

		const inheritCtx = {
			sessionManager: {
				getSessionDir: () => "/tmp/parent-session-dir",
			},
		};
		assert.equal(
			inheritSpawn.resolveSessionDirForChild(inheritCtx as any),
			"/tmp/parent-session-dir",
		);

		const harness = createHarness({
			sessionName: "parent",
			sessionDir: "/tmp/parent-session-dir",
		});
		const result = await inheritSpawn.runSpawnWorker(
			harness.api as any,
			harness.ctx as any,
			{ split: "v" },
			tmuxEnv(),
		);
		assertSuccess(result);

		const send = harness.execCalls.find((call) => call.args[0] === "send-keys");
		assert.ok(send);
		assert.match(send!.args[3], /--session-dir '\/tmp\/parent-session-dir'/);
	});
});

describe("11) worker drift warning (warn-only)", () => {
	it("warns on drift and does not force rename", async () => {
		await withEnv(
			{
				PI_WORKER_MANAGED: "1",
				PI_WORKER_NAME: "base:wrkr-1",
				PI_WORKER_NAMESPACE: "base",
				PI_WORKER_SLOT: "1",
				TMUX: undefined,
				TMUX_PANE: undefined,
			},
			async () => {
				const harness = createHarness({ sessionName: "base:wrkr-1" });
				spawnWorkerExtension(harness.api as any);

				await harness.fire("session_start");
				assert.equal(harness.setSessionNameCalls.length, 1);
				assert.equal(harness.setSessionNameCalls[0], "base:wrkr-1");

				harness.setSessionName("outside:label");
				await harness.fire("turn_start");

				const warnings = harness.notifications.filter(
					(n) => n.level === "warning" && n.message.includes("Managed worker"),
				);
				assert.equal(warnings.length, 1);
				assert.equal(
					harness.setSessionNameCalls.length,
					1,
					"warn-only policy should not force-rename drift",
				);
			},
		);
	});

	it("warnOnDrift emits one warning per drift key", () => {
		const notes: Note[] = [];
		const pi = { getSessionName: () => "other:name" };
		const ctx = {
			hasUI: true,
			ui: {
				notify(message: string, level: string) {
					notes.push({ message, level });
				},
			},
		};
		const info = {
			isManaged: true,
			expectedName: "base:wrkr-1",
			namespace: "base",
			slot: 1,
		};

		const firstKey = warnOnDrift(pi as any, ctx as any, info, undefined);
		assert.equal(firstKey, "other:name");
		assert.equal(notes.length, 1);

		const secondKey = warnOnDrift(pi as any, ctx as any, info, firstKey);
		assert.equal(secondKey, firstKey);
		assert.equal(notes.length, 1);
	});
});
