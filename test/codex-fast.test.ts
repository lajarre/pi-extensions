import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import codexFastExtension, {
	applyFastServiceTier,
	getFastEligibility,
	loadAutoFastEnabled,
	parseFastBoolean,
} from "../codex-fast.ts";

type TestModel = {
	api: string;
	id: string;
	provider: string;
};

type TestContext = {
	cwd: string;
	model: TestModel;
	modelRegistry: {
		oauth: boolean;
		isUsingOAuth: (model: Record<string, unknown>) => boolean;
	};
	ui: {
		notify: (message: string, level: string) => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
};

type EventPayload = Record<string, unknown>;
type EventHandler = (
	event: EventPayload,
	ctx: TestContext,
) => unknown | Promise<unknown>;
type CommandHandler = (
	args: string,
	ctx: TestContext,
) => unknown | Promise<unknown>;

const eligibleModel: TestModel = {
	api: "openai-codex-responses",
	id: "gpt-5.5",
	provider: "openai-codex",
};

function createCodexPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		model: eligibleModel.id,
		store: false,
		stream: true,
		instructions: "You are a helpful assistant.",
		input: [],
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
		tool_choice: "auto",
		parallel_tool_calls: true,
		...overrides,
	};
}

const originalEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
	if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const [name, value] of originalEnv.entries()) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	originalEnv.clear();
});

function createHarness(
	options: { cwd?: string; model?: TestModel; oauth?: boolean } = {},
) {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const notifications: Array<{ level: string; message: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		model: options.model ?? eligibleModel,
		modelRegistry: {
			oauth: options.oauth ?? true,
			isUsingOAuth() {
				return this.oauth;
			},
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ level, message });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
		},
	};

	const api = {
		on(event: string, handler: EventHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(
			name: string,
			command: { handler: CommandHandler },
		) {
			commands.set(name, command);
		},
	};

	codexFastExtension(api as Parameters<typeof codexFastExtension>[0]);

	return {
		commands,
		ctx,
		notifications,
		statuses,
		async command(name: string, args = "") {
			const command = commands.get(name);
			assert.ok(command, `missing command ${name}`);
			await command.handler(args, ctx);
		},
		async callProviderRequest(payload: EventPayload) {
			let result: unknown;
			for (const handler of handlers.get("before_provider_request") ??
				[]) {
				const next = await handler({ payload }, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
		async fire(event: string, payload: EventPayload = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

describe("parseFastBoolean", () => {
	it("accepts common on/off spellings", () => {
		assert.equal(parseFastBoolean("1"), true);
		assert.equal(parseFastBoolean("true"), true);
		assert.equal(parseFastBoolean("on"), true);
		assert.equal(parseFastBoolean("0"), false);
		assert.equal(parseFastBoolean("false"), false);
		assert.equal(parseFastBoolean("off"), false);
		assert.equal(parseFastBoolean("later"), undefined);
	});
});

describe("loadAutoFastEnabled", () => {
	it("uses PI_CODEX_FAST before config files", () => {
		setEnv("PI_CODEX_FAST", "on");
		assert.equal(loadAutoFastEnabled(process.cwd()), true);

		setEnv("PI_CODEX_FAST", "off");
		assert.equal(loadAutoFastEnabled(process.cwd()), false);
	});

	it("uses project config before global config", () => {
		setEnv("PI_CODEX_FAST", undefined);
		const root = mkdtempSync(path.join(tmpdir(), "pi-fast-"));
		const agentDir = path.join(root, "agent");
		const project = path.join(root, "project");
		mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
		mkdirSync(path.join(project, ".pi"), { recursive: true });
		writeFileSync(
			path.join(agentDir, "extensions", "openai-fast.json"),
			JSON.stringify({ enabled: false }),
		);
		writeFileSync(
			path.join(project, ".pi", "openai-fast.json"),
			JSON.stringify({ enabled: true }),
		);

		setEnv("PI_CODING_AGENT_DIR", agentDir);
		assert.equal(loadAutoFastEnabled(project), true);
	});
});

describe("fast eligibility", () => {
	it("requires openai-codex gpt-5.4/gpt-5.5 with OAuth", () => {
		assert.deepEqual(
			getFastEligibility({
				model: eligibleModel,
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}),
			{ ok: true },
		);

		assert.equal(
			getFastEligibility({
				model: { ...eligibleModel, id: "gpt-5.4" },
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}).ok,
			true,
		);
		assert.equal(
			getFastEligibility({
				model: { ...eligibleModel, id: "gpt-5.4-mini" },
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}).ok,
			false,
		);
		assert.equal(
			getFastEligibility({
				model: { ...eligibleModel, provider: "openai-codex-second" },
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}).ok,
			false,
		);
		assert.equal(
			getFastEligibility({
				model: { ...eligibleModel, api: "openai-responses" },
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}).ok,
			false,
		);
		assert.equal(
			getFastEligibility({
				model: eligibleModel,
				modelRegistry: {
					oauth: false,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			}).ok,
			false,
		);
	});

	it("preserves the model registry binding when checking OAuth", () => {
		const modelRegistry = {
			oauth: true,
			isUsingOAuth(model: Record<string, unknown>) {
				assert.equal(this, modelRegistry);
				return this.oauth && model.provider === "openai-codex";
			},
		};

		assert.deepEqual(
			getFastEligibility({ model: eligibleModel, modelRegistry }),
			{ ok: true },
		);
	});
});

describe("applyFastServiceTier", () => {
	it("adds priority for eligible Codex payloads", () => {
		const result = applyFastServiceTier(createCodexPayload(), {
			model: eligibleModel,
			modelRegistry: {
				oauth: true,
				isUsingOAuth() {
					return this.oauth;
				},
			},
		});

		assert.deepEqual(result, {
			store: false,
			model: "gpt-5.5",
			stream: true,
			instructions: "You are a helpful assistant.",
			input: [],
			text: { verbosity: "low" },
			include: ["reasoning.encrypted_content"],
			tool_choice: "auto",
			parallel_tool_calls: true,
			service_tier: "priority",
		});
	});

	it("does not overwrite an existing service_tier", () => {
		const result = applyFastServiceTier(
			createCodexPayload({ service_tier: "flex" }),
			{
				model: eligibleModel,
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			},
		);

		assert.equal(result, undefined);
	});

	it("treats nullish service_tier values as unset", () => {
		for (const serviceTier of [undefined, null]) {
			const result = applyFastServiceTier(
				createCodexPayload({ service_tier: serviceTier }),
				{
					model: eligibleModel,
					modelRegistry: {
						oauth: true,
						isUsingOAuth() {
							return this.oauth;
						},
					},
				},
			);

			assert.equal(result?.service_tier, "priority");
		}
	});

	it("skips payloads that do not match the active model", () => {
		const result = applyFastServiceTier(
			createCodexPayload({ model: "gpt-5.4" }),
			{
				model: eligibleModel,
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			},
		);

		assert.equal(result, undefined);
	});

	it("skips non-OAuth Codex payloads", () => {
		const result = applyFastServiceTier(createCodexPayload(), {
			model: eligibleModel,
			modelRegistry: {
				oauth: false,
				isUsingOAuth() {
					return this.oauth;
				},
			},
		});

		assert.equal(result, undefined);
	});

	it("skips same-id payloads without the Codex Responses request shape", () => {
		const result = applyFastServiceTier(
			{ model: "gpt-5.5", stream: true },
			{
				model: eligibleModel,
				modelRegistry: {
					oauth: true,
					isUsingOAuth() {
						return this.oauth;
					},
				},
			},
		);

		assert.equal(result, undefined);
	});
});

describe("/fast command", () => {
	it("enables injection after /fast on", async () => {
		setEnv("PI_CODEX_FAST", undefined);
		const harness = createHarness();

		assert.equal(
			await harness.callProviderRequest({ model: "gpt-5.5" }),
			undefined,
		);
		assert.equal(harness.statuses.get("fast"), undefined);

		await harness.command("fast", "on");
		assert.deepEqual(
			await harness.callProviderRequest(createCodexPayload()),
			{
				store: false,
				model: "gpt-5.5",
				stream: true,
				instructions: "You are a helpful assistant.",
				input: [],
				text: { verbosity: "low" },
				include: ["reasoning.encrypted_content"],
				tool_choice: "auto",
				parallel_tool_calls: true,
				service_tier: "priority",
			},
		);
		assert.equal(harness.statuses.get("fast"), "fast");
	});

	it("blocks manual enablement when the current model is not eligible", async () => {
		const harness = createHarness({
			model: { ...eligibleModel, id: "gpt-5.4-mini" },
		});

		await harness.command("fast", "on");

		assert.equal(harness.notifications.at(-1)?.level, "error");
		assert.match(
			harness.notifications.at(-1)?.message ?? "",
			/model does not support/,
		);
	});
});
