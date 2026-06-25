import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "fast";
const FAST_PROVIDER_PREFIX = "openai-codex";
const FAST_API_ID = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const FAST_MODELS = new Set(["gpt-5.4", "gpt-5.5"]);

type FastOverride = "auto" | "on" | "off";
type FastEligibility = { ok: true } | { ok: false; reason: string };

type FastModel = {
	api?: string;
	id?: string;
	provider?: string;
};

type FastContext = {
	cwd?: string;
	hasUI?: boolean;
	model?: FastModel;
	modelRegistry?: {
		isUsingOAuth?: (model: FastModel) => boolean;
	};
	ui?: {
		notify?: (
			message: string,
			level: "info" | "warning" | "error",
		) => void;
		setStatus?: (key: string, value: string | undefined) => void;
	};
};

type RequestPayload = Record<string, unknown>;

type JsonObject = Record<string, unknown>;

export class CodexFastConfigError extends Error {
	readonly code:
		| "PI_CODEX_FAST_ENV_INVALID"
		| "PI_CODEX_FAST_CONFIG_UNREADABLE"
		| "PI_CODEX_FAST_CONFIG_INVALID";

	constructor(
		code:
			| "PI_CODEX_FAST_ENV_INVALID"
			| "PI_CODEX_FAST_CONFIG_UNREADABLE"
			| "PI_CODEX_FAST_CONFIG_INVALID",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "CodexFastConfigError";
	}
}

export function parseFastBoolean(
	value: string | undefined,
): boolean | undefined {
	if (value === undefined) return undefined;

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return undefined;
	}
}

function readJsonConfig(path: string, label: string): JsonObject {
	if (!existsSync(path)) return {};

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_UNREADABLE",
			`Cannot read ${label} at ${path}: ${formatError(error)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_INVALID",
			`Invalid ${label} JSON at ${path}: ${formatError(error)}`,
		);
	}

	if (!isPlainObject(parsed)) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_INVALID",
			`${label} at ${path} must be a JSON object`,
		);
	}

	return parsed;
}

function isPlainObject(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatError(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: String(error);
}

function getAgentDir(): string {
	return (
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
	);
}

export function findProjectFastConfig(
	cwd: string,
	fileName = "openai-fast.json",
): string | undefined {
	let current = resolve(cwd);

	while (true) {
		const candidate = join(current, ".pi", fileName);
		if (existsSync(candidate)) return candidate;

		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function booleanConfigValue(config: JsonObject): boolean | undefined {
	return typeof config.enabled === "boolean"
		? config.enabled
		: undefined;
}

function readSidecarFastEnabled(path: string): boolean | undefined {
	const config = readJsonConfig(path, "Codex Fast config");
	if (
		Object.hasOwn(config, "enabled") &&
		typeof config.enabled !== "boolean"
	) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_INVALID",
			`Codex Fast config at ${path} must set enabled to a boolean`,
		);
	}

	return booleanConfigValue(config);
}

function readSettingsFastEnabled(path: string): boolean | undefined {
	const settings = readJsonConfig(path, "Pi settings");
	if (!Object.hasOwn(settings, "codexFast")) return undefined;

	if (!isPlainObject(settings.codexFast)) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_INVALID",
			`Pi settings at ${path} must set codexFast to an object`,
		);
	}

	const config = settings.codexFast;
	if (
		Object.hasOwn(config, "enabled") &&
		typeof config.enabled !== "boolean"
	) {
		throw new CodexFastConfigError(
			"PI_CODEX_FAST_CONFIG_INVALID",
			`Pi settings at ${path} must set codexFast.enabled to a boolean`,
		);
	}

	return booleanConfigValue(config);
}

export function loadAutoFastEnabled(cwd: string): boolean {
	const envEnabled = readEnvFastEnabled();
	if (envEnabled !== undefined) return envEnabled;

	const projectSettingsPath = findProjectFastConfig(
		cwd,
		"settings.json",
	);
	if (projectSettingsPath) {
		const projectSettingsEnabled = readSettingsFastEnabled(
			projectSettingsPath,
		);
		if (projectSettingsEnabled !== undefined) {
			return projectSettingsEnabled;
		}
	}

	const projectConfigPath = findProjectFastConfig(cwd);
	if (projectConfigPath) {
		const projectEnabled = readSidecarFastEnabled(projectConfigPath);
		if (projectEnabled !== undefined) return projectEnabled;
	}

	const globalSettingsEnabled = readSettingsFastEnabled(
		join(getAgentDir(), "settings.json"),
	);
	if (globalSettingsEnabled !== undefined) return globalSettingsEnabled;

	const globalConfig = readSidecarFastEnabled(
		join(getAgentDir(), "extensions", "openai-fast.json"),
	);
	return globalConfig ?? false;
}

function readEnvFastEnabled(): boolean | undefined {
	const value = process.env.PI_CODEX_FAST;
	if (value === undefined) return undefined;

	const parsed = parseFastBoolean(value);
	if (parsed !== undefined) return parsed;

	throw new CodexFastConfigError(
		"PI_CODEX_FAST_ENV_INVALID",
		`PI_CODEX_FAST must be one of 1,true,yes,on,0,false,no,off; got ${JSON.stringify(value)}`,
	);
}

function isOpenAICodexProvider(provider: unknown): boolean {
	return provider === FAST_PROVIDER_PREFIX;
}

export function getFastEligibility(ctx: FastContext): FastEligibility {
	const model = ctx.model;
	if (!model) return { ok: false, reason: "no active model" };
	if (!isOpenAICodexProvider(model.provider)) {
		return { ok: false, reason: "provider is not openai-codex" };
	}
	if (model.api !== FAST_API_ID) {
		return {
			ok: false,
			reason: "provider API is not openai-codex-responses",
		};
	}
	if (!FAST_MODELS.has(String(model.id))) {
		return {
			ok: false,
			reason: "model does not support Codex Fast mode",
		};
	}

	const modelRegistry = ctx.modelRegistry;
	if (typeof modelRegistry?.isUsingOAuth !== "function") {
		return { ok: false, reason: "auth mode cannot be verified" };
	}
	if (!modelRegistry.isUsingOAuth(model)) {
		return { ok: false, reason: "auth is not ChatGPT OAuth" };
	}

	return { ok: true };
}

function isPayloadObject(payload: unknown): payload is RequestPayload {
	return (
		!!payload && typeof payload === "object" && !Array.isArray(payload)
	);
}

function isCodexResponsesRequestPayload(
	payload: RequestPayload,
	modelId: string | undefined,
): boolean {
	return (
		payload.model === modelId &&
		payload.store === false &&
		payload.stream === true &&
		typeof payload.instructions === "string" &&
		Array.isArray(payload.input) &&
		Array.isArray(payload.include) &&
		payload.include.includes("reasoning.encrypted_content") &&
		payload.tool_choice === "auto" &&
		payload.parallel_tool_calls === true
	);
}

export function applyFastServiceTier(
	payload: unknown,
	ctx: FastContext,
): RequestPayload | undefined {
	const eligibility = getFastEligibility(ctx);
	if (!eligibility.ok) return undefined;
	if (!isPayloadObject(payload)) return undefined;
	if (
		payload.service_tier !== undefined &&
		payload.service_tier !== null
	) {
		return undefined;
	}
	if (!isCodexResponsesRequestPayload(payload, ctx.model?.id)) {
		return undefined;
	}

	return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function updateFastStatus(ctx: FastContext, enabled: boolean): void {
	if (!ctx.ui?.setStatus) return;
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const eligibility = getFastEligibility(ctx);
	ctx.ui.setStatus(STATUS_KEY, eligibility.ok ? "fast" : undefined);
}

function notify(
	ctx: FastContext,
	message: string,
	level: "info" | "warning" | "error",
) {
	ctx.ui?.notify?.(message, level);
}

function fastStatusSuffix(ctx: FastContext, enabled: boolean): string {
	if (!enabled) return "inactive";

	const eligibility = getFastEligibility(ctx);
	return eligibility.ok
		? "eligible"
		: `ineligible: ${eligibility.reason}`;
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let autoEnabled = loadAutoFastEnabled(process.cwd());
	let override: FastOverride = "auto";

	const isFastEnabled = (): boolean => {
		if (override === "on") return true;
		if (override === "off") return false;
		return autoEnabled;
	};

	const modeLabel = (): string => {
		if (override !== "auto") return override;
		return autoEnabled ? "auto on" : "auto off";
	};

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode",
		handler: async (args: string, ctx: FastContext) => {
			const command = String(args || "")
				.trim()
				.toLowerCase();

			if (command === "status") {
				const eligibility = getFastEligibility(ctx);
				const suffix = eligibility.ok
					? "eligible"
					: `ineligible: ${eligibility.reason}`;
				notify(
					ctx,
					`fast mode: ${isFastEnabled() ? "on" : "off"} (${modeLabel()}, ${suffix})`,
					"info",
				);
				updateFastStatus(ctx, isFastEnabled());
				return;
			}

			if (command === "auto") {
				autoEnabled = loadAutoFastEnabled(ctx.cwd ?? process.cwd());
				override = "auto";
			} else if (command === "off") {
				override = "off";
			} else if (command === "on" || command === "") {
				if (command === "" && isFastEnabled()) {
					override = "off";
				} else {
					const eligibility = getFastEligibility(ctx);
					if (!eligibility.ok) {
						notify(
							ctx,
							`Fast mode is not available for the current session (${eligibility.reason}).`,
							"error",
						);
						updateFastStatus(ctx, isFastEnabled());
						return;
					}
					override = "on";
				}
			} else {
				notify(ctx, "Usage: /fast [on|off|auto|status]", "error");
				return;
			}

			const enabled = isFastEnabled();
			updateFastStatus(ctx, enabled);
			const suffix = fastStatusSuffix(ctx, enabled);
			notify(
				ctx,
				`fast mode ${enabled ? "enabled" : "disabled"} (${modeLabel()}, ${suffix})`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx: FastContext) => {
		autoEnabled = loadAutoFastEnabled(ctx.cwd ?? process.cwd());
		override = "auto";
		updateFastStatus(ctx, isFastEnabled());
	});

	pi.on("model_select", (_event, ctx: FastContext) => {
		updateFastStatus(ctx, isFastEnabled());
	});

	pi.on("before_provider_request", (event, ctx: FastContext) => {
		updateFastStatus(ctx, isFastEnabled());
		if (!isFastEnabled()) return;
		return applyFastServiceTier(event.payload, ctx);
	});
}
