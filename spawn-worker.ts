import { StringEnum } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export type SplitDirection = "v" | "h";
export type SessionDirMode = "default" | "inherit";
export type DriftPolicy = "warn" | "enforce";

export interface SpawnState {
	workerNamespace: string;
	nextSlot: number;
}

export interface WorkerRecord {
	name: string;
	paneId: string;
	namespace: string;
	slot: number;
	createdAt: number;
}

export interface SpawnRequest {
	suffix?: string;
	split: SplitDirection;
}

export interface SpawnSuccess {
	ok: true;
	paneId: string;
	childName: string;
	namespace: string;
	slot: number;
	split: SplitDirection;
	message: string;
}

export interface SpawnFailure {
	ok: false;
	error: string;
}

export type SpawnResult = SpawnSuccess | SpawnFailure;

export interface SendWorkerRequest {
	target: string;
	message: string;
}

export interface SendWorkerSuccess {
	ok: true;
	workerName: string;
	message: string;
}

export interface SendWorkerFailure {
	ok: false;
	error: string;
	fallback: string;
}

export type SendWorkerResult = SendWorkerSuccess | SendWorkerFailure;

export interface PlannedSpawn {
	namespace: string;
	slot: number;
	childName: string;
	nextState: SpawnState;
}

export interface LaunchCommandInput {
	cwd: string;
	childName: string;
	namespace: string;
	slot: number;
	sessionDir?: string;
}

export interface ManagedWorkerInfo {
	isManaged: boolean;
	expectedName?: string;
	namespace?: string;
	slot?: number;
}

export interface ManagedWorkerEntry {
	namespace: string;
	slot: number;
	expectedName: string;
}

export const SPAWN_STATE_CUSTOM_TYPE = "spawn-worker-state";
export const SPAWN_MANAGED_CUSTOM_TYPE = "spawn-worker-managed";
export const SPAWN_REGISTRY_CUSTOM_TYPE = "spawn-worker-registry";
export const MAX_SUFFIX_LENGTH = 64;
export const AUTO_PREFIX = "wrkr-";

// V1: default to normal Pi behavior (do not force --session-dir).
export const sessionDirMode: SessionDirMode = "default";
export const driftPolicy: DriftPolicy = "warn";

export class SpawnWorkerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpawnWorkerError";
	}
}

export function isSplitDirection(value: string | undefined): value is SplitDirection {
	return value === "v" || value === "h";
}

export function splitCommandArgs(args: string): string[] {
	const trimmed = args.trim();
	if (!trimmed) return [];
	return trimmed.split(/\s+/).filter(Boolean);
}

export function parseSpawnCommandArgs(args: string): SpawnRequest {
	const tokens = splitCommandArgs(args);
	if (tokens.length === 0) {
		return { split: "v" };
	}

	if (tokens.length === 1) {
		if (isSplitDirection(tokens[0])) {
			return { split: tokens[0] };
		}
		return { suffix: tokens[0], split: "v" };
	}

	if (tokens.length === 2) {
		const [suffix, split] = tokens;
		if (!isSplitDirection(split)) {
			throw new SpawnWorkerError(
				`Invalid split argument \"${split}\". Use \"v\" or \"h\".`,
			);
		}
		return { suffix, split };
	}

	throw new SpawnWorkerError("Usage: /spawn [suffix] [v|h]");
}

export function parseSpawnToolArgs(params: {
	suffix?: string;
	split?: SplitDirection;
}): SpawnRequest {
	const split = params.split ?? "v";
	if (!isSplitDirection(split)) {
		throw new SpawnWorkerError(
			`Invalid split argument \"${String(params.split)}\". Use \"v\" or \"h\".`,
		);
	}

	if (params.suffix === undefined) {
		return { split };
	}

	const suffix = params.suffix.trim();
	if (!suffix) {
		throw new SpawnWorkerError("Suffix cannot be empty.");
	}

	return { suffix, split };
}

export function sanitizeSuffix(rawSuffix: string): string {
	const sanitized = rawSuffix
		.replace(/[^a-zA-Z0-9._:-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "")
		.slice(0, MAX_SUFFIX_LENGTH)
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");

	if (!sanitized) {
		throw new SpawnWorkerError(
			"Suffix becomes empty after sanitization. Use letters, numbers, ., _, :, or -.",
		);
	}

	return sanitized;
}

export function normalizeSpawnState(data: unknown): SpawnState | undefined {
	if (!data || typeof data !== "object") return undefined;

	const maybeNamespace = (data as { workerNamespace?: unknown }).workerNamespace;
	const maybeNextSlot = (data as { nextSlot?: unknown }).nextSlot;

	if (typeof maybeNamespace !== "string") return undefined;
	const workerNamespace = maybeNamespace.trim();
	if (!workerNamespace) return undefined;

	const nextSlot = Number(maybeNextSlot);
	if (!Number.isInteger(nextSlot) || nextSlot < 1) return undefined;

	return { workerNamespace, nextSlot };
}

export function loadState(
	ctx: Pick<ExtensionContext, "sessionManager">,
): SpawnState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i] as SessionEntry;
		if (entry.type !== "custom") continue;
		if (entry.customType !== SPAWN_STATE_CUSTOM_TYPE) continue;
		const state = normalizeSpawnState(entry.data);
		if (state) return state;
	}
	return undefined;
}

export function saveState(pi: Pick<ExtensionAPI, "appendEntry">, state: SpawnState): void {
	pi.appendEntry(SPAWN_STATE_CUSTOM_TYPE, state);
}

export function normalizeRegistry(data: unknown): WorkerRecord[] | undefined {
	if (!Array.isArray(data)) return undefined;

	const records: WorkerRecord[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;

		const maybeName = (item as { name?: unknown }).name;
		const maybePaneId = (item as { paneId?: unknown }).paneId;
		const maybeNamespace = (item as { namespace?: unknown }).namespace;
		const maybeSlot = (item as { slot?: unknown }).slot;
		const maybeCreatedAt = (item as { createdAt?: unknown }).createdAt;

		if (typeof maybeName !== "string") continue;
		const name = maybeName.trim();
		if (!name) continue;

		if (typeof maybePaneId !== "string") continue;
		const paneId = maybePaneId.trim();
		if (!paneId) continue;

		if (typeof maybeNamespace !== "string") continue;
		const namespace = maybeNamespace.trim();
		if (!namespace) continue;

		const slot = Number(maybeSlot);
		if (!Number.isInteger(slot) || slot < 1) continue;

		const createdAt = Number(maybeCreatedAt);
		if (!Number.isFinite(createdAt) || createdAt < 0) continue;

		records.push({
			name,
			paneId,
			namespace,
			slot,
			createdAt,
		});
	}

	return records;
}

export function loadRegistry(
	ctx: Pick<ExtensionContext, "sessionManager">,
): WorkerRecord[] {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i] as SessionEntry;
		if (entry.type !== "custom") continue;
		if (entry.customType !== SPAWN_REGISTRY_CUSTOM_TYPE) continue;
		const records = normalizeRegistry(entry.data);
		if (records) return records;
	}
	return [];
}

export function saveRegistry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	records: WorkerRecord[],
): void {
	pi.appendEntry(SPAWN_REGISTRY_CUSTOM_TYPE, records);
}

export function upsertWorker(
	records: WorkerRecord[],
	worker: WorkerRecord,
): WorkerRecord[] {
	const deduped = records.filter((record) => record.name !== worker.name);
	deduped.push(worker);
	return deduped;
}

export function formatWorkerAge(createdAt: number, now: number = Date.now()): string {
	const deltaSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (deltaSeconds < 5) return "just now";
	if (deltaSeconds < 60) return `${deltaSeconds}s ago`;

	const deltaMinutes = Math.floor(deltaSeconds / 60);
	if (deltaMinutes < 60) return `${deltaMinutes}m ago`;

	const deltaHours = Math.floor(deltaMinutes / 60);
	if (deltaHours < 24) return `${deltaHours}h ago`;

	const deltaDays = Math.floor(deltaHours / 24);
	return `${deltaDays}d ago`;
}

export function formatWorkerLine(
	record: WorkerRecord,
	now: number = Date.now(),
): string {
	return (
		`${record.name} | pane ${record.paneId} | slot ${record.slot} | `
		+ `${formatWorkerAge(record.createdAt, now)}`
	);
}

export function buildWorkersListMessage(
	records: WorkerRecord[],
	currentNamespace?: string,
	now: number = Date.now(),
): string {
	if (records.length === 0) {
		return "No known workers. Run /spawn to create a managed worker.";
	}

	const inCurrentNamespace = currentNamespace
		? records
			.filter((record) => record.namespace === currentNamespace)
			.slice()
			.sort((left, right) => right.createdAt - left.createdAt)
		: [];
	const inOtherNamespaces = currentNamespace
		? records
			.filter((record) => record.namespace !== currentNamespace)
			.slice()
			.sort((left, right) => right.createdAt - left.createdAt)
		: records
			.slice()
			.sort((left, right) => right.createdAt - left.createdAt);

	const lines = ["Known workers (session-control registry):"];
	if (currentNamespace && inCurrentNamespace.length > 0) {
		lines.push(`Current namespace (${currentNamespace}):`);
		for (const record of inCurrentNamespace) {
			lines.push(`- ${formatWorkerLine(record, now)}`);
		}
	}

	if (inOtherNamespaces.length > 0) {
		if (currentNamespace && inCurrentNamespace.length > 0) {
			lines.push("Other namespaces:");
		}
		for (const record of inOtherNamespaces) {
			lines.push(`- ${formatWorkerLine(record, now)}`);
		}
	}

	return lines.join("\n");
}

export function parseSendWorkerCommandArgs(args: string): SendWorkerRequest {
	const trimmed = args.trim();
	if (!trimmed) {
		throw new SpawnWorkerError("Usage: /send-worker <target> <message>");
	}

	const firstWhitespace = trimmed.search(/\s/);
	if (firstWhitespace === -1) {
		throw new SpawnWorkerError("Usage: /send-worker <target> <message>");
	}

	const target = trimmed.slice(0, firstWhitespace).trim();
	const message = trimmed.slice(firstWhitespace).trim();
	if (!target || !message) {
		throw new SpawnWorkerError("Usage: /send-worker <target> <message>");
	}

	return { target, message };
}

export function resolveWorkerTarget(
	registry: WorkerRecord[],
	target: string,
): WorkerRecord {
	const trimmedTarget = target.trim();
	if (!trimmedTarget) {
		throw new SpawnWorkerError("Worker target cannot be empty.");
	}

	if (registry.length === 0) {
		throw new SpawnWorkerError(
			"No known workers. Run /spawn to create a managed worker.",
		);
	}

	const exactMatch = registry.find((record) => record.name === trimmedTarget);
	if (exactMatch) return exactMatch;

	const selectMostRecent = (records: WorkerRecord[]): WorkerRecord | undefined => {
		let latest: WorkerRecord | undefined;
		for (const record of records) {
			if (!latest || record.createdAt >= latest.createdAt) {
				latest = record;
			}
		}
		return latest;
	};

	if (trimmedTarget.startsWith(AUTO_PREFIX)) {
		const slotFromToken = parseSlot(trimmedTarget.slice(AUTO_PREFIX.length));
		if (slotFromToken) {
			const bySlotToken = selectMostRecent(
				registry.filter((record) => record.slot === slotFromToken),
			);
			if (bySlotToken) return bySlotToken;
		}
	}

	if (/^[0-9]+$/.test(trimmedTarget)) {
		const numericSlot = parseSlot(trimmedTarget);
		if (numericSlot) {
			const byNumericSlot = selectMostRecent(
				registry.filter((record) => record.slot === numericSlot),
			);
			if (byNumericSlot) return byNumericSlot;
		}
	}

	const availableNames = registry.map((record) => record.name).join(", ");
	throw new SpawnWorkerError(
		`Unknown worker target "${trimmedTarget}". Known workers: ${availableNames}`,
	);
}

export function buildSendWorkerBridgeArgs(
	workerName: string,
	message: string,
): string[] {
	return [
		"-p",
		"--session-control",
		"--control-session",
		workerName,
		"--send-session-message",
		message,
		"--send-session-mode",
		"follow_up",
		"--send-session-wait",
		"message_processed",
	];
}

export function buildSendWorkerFallback(
	workerName: string,
	message: string,
): string {
	return (
		"Fallback (existing session-control utility path): run "
		+ "pi -p --session-control "
		+ `--control-session ${shellQuote(workerName)} `
		+ `--send-session-message ${shellQuote(message)} `
		+ "--send-session-mode follow_up "
		+ "--send-session-wait message_processed"
	);
}

export async function sendWorkerMessage(
	pi: Pick<ExtensionAPI, "exec">,
	workerName: string,
	message: string,
): Promise<SendWorkerResult> {
	const trimmedWorker = workerName.trim();
	if (!trimmedWorker) {
		return {
			ok: false,
			error: "Worker name cannot be empty.",
			fallback: "Fallback: resolve a worker via /workers, then retry.",
		};
	}

	if (!message.trim()) {
		return {
			ok: false,
			error: "Message cannot be empty.",
			fallback: "Usage: /send-worker <target> <message>",
		};
	}

	const args = buildSendWorkerBridgeArgs(trimmedWorker, message);
	try {
		const result = await pi.exec("pi", args);
		if (result.code === 0) {
			return {
				ok: true,
				workerName: trimmedWorker,
				message: `Sent message to ${trimmedWorker} via session-control bridge.`,
			};
		}

		const details = summarizeExecFailure(result.stdout, result.stderr, result.code);
		return {
			ok: false,
			error: `session-control bridge failed: ${details}`,
			fallback: buildSendWorkerFallback(trimmedWorker, message),
		};
	} catch (error: unknown) {
		const detail = error instanceof Error && error.message.trim()
			? error.message.trim()
			: "unknown execution error";
		return {
			ok: false,
			error: `session-control bridge failed: ${detail}`,
			fallback: buildSendWorkerFallback(trimmedWorker, message),
		};
	}
}

export function resolveParentName(pi: Pick<ExtensionAPI, "getSessionName">): string {
	const parentName = pi.getSessionName()?.trim();
	if (!parentName) {
		throw new SpawnWorkerError("Set a parent name first via /name <name>");
	}
	return parentName;
}

export function buildChildName(namespace: string, slot: number, suffix?: string): string {
	if (suffix) {
		return `${namespace}:${sanitizeSuffix(suffix)}`;
	}
	return `${namespace}:${AUTO_PREFIX}${slot}`;
}

export function planSpawn(
	parentName: string,
	state: SpawnState | undefined,
	suffix?: string,
): PlannedSpawn {
	const baseState = state ?? {
		workerNamespace: parentName,
		nextSlot: 1,
	};

	const slot = baseState.nextSlot;
	const namespace = baseState.workerNamespace;
	const childName = buildChildName(namespace, slot, suffix);

	return {
		namespace,
		slot,
		childName,
		nextState: {
			workerNamespace: namespace,
			nextSlot: slot + 1,
		},
	};
}

export function ensureTmuxSession(env: NodeJS.ProcessEnv = process.env): void {
	if (!env.TMUX || !env.TMUX.trim()) {
		throw new SpawnWorkerError(
			"Not inside tmux (TMUX is not set). Start pi in tmux and retry.",
		);
	}
}

export async function ensureTmuxCommand(
	pi: Pick<ExtensionAPI, "exec">,
): Promise<void> {
	try {
		const probe = await pi.exec("tmux", ["-V"]);
		if (probe.code === 0) return;

		const details = summarizeExecFailure(probe.stdout, probe.stderr, probe.code);
		throw new SpawnWorkerError(`tmux is unavailable: ${details}`);
	} catch (error: unknown) {
		if (error instanceof SpawnWorkerError) throw error;
		throw new SpawnWorkerError("tmux command is not available in PATH.");
	}
}

export function summarizeExecFailure(
	stdout: string,
	stderr: string,
	code: number,
): string {
	const detail = (stderr || stdout || "").trim();
	if (detail) return detail;
	return `exit code ${code}`;
}

export function buildSplitArgs(
	split: SplitDirection,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const args = ["split-window"];
	const pane = env.TMUX_PANE?.trim();
	if (pane) {
		args.push("-t", pane);
	}
	args.push("-d", `-${split}`, "-P", "-F", "#{pane_id}");
	return args;
}

export function parsePaneId(stdout: string): string {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean) ?? "";
}

export async function splitTmuxPane(
	pi: Pick<ExtensionAPI, "exec">,
	split: SplitDirection,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const result = await pi.exec("tmux", buildSplitArgs(split, env));
	if (result.code !== 0) {
		const details = summarizeExecFailure(result.stdout, result.stderr, result.code);
		throw new SpawnWorkerError(`tmux split failed: ${details}`);
	}

	const paneId = parsePaneId(result.stdout);
	if (!paneId) {
		throw new SpawnWorkerError("tmux split succeeded but returned no pane id.");
	}

	return paneId;
}

export function shellQuote(value: string): string {
	if (!value) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveSessionDirForChild(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	if (sessionDirMode !== "inherit") return undefined;
	const sessionDir = ctx.sessionManager.getSessionDir()?.trim();
	if (!sessionDir) return undefined;
	return sessionDir;
}

export function buildWorkerLaunchCommand(input: LaunchCommandInput): string {
	const exports = [
		`PI_WORKER_NAME=${shellQuote(input.childName)}`,
		`PI_WORKER_NAMESPACE=${shellQuote(input.namespace)}`,
		`PI_WORKER_SLOT=${shellQuote(String(input.slot))}`,
		"PI_WORKER_MANAGED=1",
	].join(" ");

	const childArgs: string[] = ["pi", "--session-control"];
	if (input.sessionDir) {
		childArgs.push("--session-dir", shellQuote(input.sessionDir));
	}

	return `cd -- ${shellQuote(input.cwd)} && ${exports} ${childArgs.join(" ")}`;
}

export async function sendLaunchCommand(
	pi: Pick<ExtensionAPI, "exec">,
	paneId: string,
	launchCommand: string,
): Promise<void> {
	const result = await pi.exec("tmux", [
		"send-keys",
		"-t",
		paneId,
		launchCommand,
		"C-m",
	]);

	if (result.code !== 0) {
		const details = summarizeExecFailure(result.stdout, result.stderr, result.code);
		throw new SpawnWorkerError(
			`tmux send-keys failed: ${details}. Pane ${paneId} was created but child launch did not complete.`,
		);
	}
}

export async function spawnWorker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: SpawnRequest,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SpawnSuccess> {
	ensureTmuxSession(env);
	await ensureTmuxCommand(pi);

	const parentName = resolveParentName(pi);
	const state = loadState(ctx);
	const planned = planSpawn(parentName, state, request.suffix);

	const paneId = await splitTmuxPane(pi, request.split, env);
	const sessionDir = resolveSessionDirForChild(ctx);
	const launchCommand = buildWorkerLaunchCommand({
		cwd: ctx.cwd,
		childName: planned.childName,
		namespace: planned.namespace,
		slot: planned.slot,
		sessionDir,
	});

	await sendLaunchCommand(pi, paneId, launchCommand);
	saveState(pi, planned.nextState);

	const registry = loadRegistry(ctx);
	const nextRegistry = upsertWorker(registry, {
		name: planned.childName,
		paneId,
		namespace: planned.namespace,
		slot: planned.slot,
		createdAt: Date.now(),
	});
	saveRegistry(pi, nextRegistry);

	return {
		ok: true,
		paneId,
		childName: planned.childName,
		namespace: planned.namespace,
		slot: planned.slot,
		split: request.split,
		message:
			`spawned ${planned.childName} in pane ${paneId} `
			+ `(${request.split}); launched with pi --session-control`,
	};
}

export function toSpawnFailure(error: unknown): SpawnFailure {
	if (error instanceof SpawnWorkerError) {
		return { ok: false, error: error.message };
	}

	if (error instanceof Error && error.message.trim()) {
		return { ok: false, error: error.message.trim() };
	}

	return {
		ok: false,
		error: "Spawn failed with an unknown error.",
	};
}

export async function runSpawnWorker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: SpawnRequest,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SpawnResult> {
	try {
		return await spawnWorker(pi, ctx, request, env);
	} catch (error: unknown) {
		return toSpawnFailure(error);
	}
}

export function parseSlot(slotValue: string | undefined): number | undefined {
	if (!slotValue) return undefined;
	const trimmed = slotValue.trim();
	if (!trimmed) return undefined;
	const parsed = Number(trimmed);
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function getManagedWorkerInfo(
	env: NodeJS.ProcessEnv = process.env,
): ManagedWorkerInfo {
	const expectedName = env.PI_WORKER_NAME?.trim() || undefined;
	const namespace = env.PI_WORKER_NAMESPACE?.trim() || undefined;
	const slot = parseSlot(env.PI_WORKER_SLOT);
	const managedFlag = env.PI_WORKER_MANAGED?.trim();
	const isManaged = managedFlag === "1" || Boolean(expectedName);

	return {
		isManaged,
		expectedName,
		namespace,
		slot,
	};
}

export function toManagedEntry(
	info: ManagedWorkerInfo,
): ManagedWorkerEntry | undefined {
	if (!info.expectedName) return undefined;
	if (!info.namespace) return undefined;
	if (!info.slot) return undefined;
	return {
		namespace: info.namespace,
		slot: info.slot,
		expectedName: info.expectedName,
	};
}

export function isManagedNameInNamespace(
	currentName: string,
	namespace: string,
): boolean {
	return currentName.startsWith(`${namespace}:`);
}

export function isNameDrifted(
	currentName: string | undefined,
	info: ManagedWorkerInfo,
): boolean {
	const trimmed = currentName?.trim();
	if (!trimmed) return true;

	if (info.namespace) {
		return !isManagedNameInNamespace(trimmed, info.namespace);
	}

	if (info.expectedName) {
		return trimmed !== info.expectedName;
	}

	return false;
}

export function driftWarningMessage(
	currentName: string | undefined,
	info: ManagedWorkerInfo,
): string {
	const shownCurrent = currentName?.trim() || "(unnamed)";
	const target = info.namespace
		? `${info.namespace}:*`
		: info.expectedName ?? "managed worker namespace";

	return (
		`Managed worker name drift: ${shownCurrent} is outside ${target}. `
		+ "Warn-only policy active; rename drift may reduce traceability."
	);
}

export function driftEnforcedMessage(
	currentName: string | undefined,
	expectedName: string,
): string {
	const shownCurrent = currentName?.trim() || "(unnamed)";
	return (
		`Managed worker name drift: ${shownCurrent}. `
		+ `Enforce policy active; auto-restored to ${expectedName}.`
	);
}

export function warnOnDrift(
	pi: Pick<ExtensionAPI, "getSessionName" | "setSessionName">,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	managedInfo: ManagedWorkerInfo,
	lastDriftKey: string | undefined,
	policy: DriftPolicy = driftPolicy,
): string | undefined {
	if (!managedInfo.isManaged) return lastDriftKey;
	const currentName = pi.getSessionName();
	if (!isNameDrifted(currentName, managedInfo)) {
		return undefined;
	}

	const driftKey = currentName?.trim() || "(unnamed)";
	if (policy === "enforce" && managedInfo.expectedName) {
		pi.setSessionName(managedInfo.expectedName);
	}

	if (driftKey !== lastDriftKey && ctx.hasUI) {
		const message = policy === "enforce" && managedInfo.expectedName
			? driftEnforcedMessage(currentName, managedInfo.expectedName)
			: driftWarningMessage(currentName, managedInfo);
		ctx.ui.notify(message, "warning");
	}

	return driftKey;
}

export default function spawnWorkerExtension(pi: ExtensionAPI) {
	const managedInfo = getManagedWorkerInfo();
	let lastDriftKey: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (managedInfo.expectedName) {
			pi.setSessionName(managedInfo.expectedName);
		}

		const managedEntry = toManagedEntry(managedInfo);
		if (managedEntry) {
			pi.appendEntry(SPAWN_MANAGED_CUSTOM_TYPE, managedEntry);
		}

		lastDriftKey = warnOnDrift(
			pi,
			ctx,
			managedInfo,
			lastDriftKey,
			driftPolicy,
		);
	});

	pi.on("turn_start", async (_event, ctx) => {
		lastDriftKey = warnOnDrift(
			pi,
			ctx,
			managedInfo,
			lastDriftKey,
			driftPolicy,
		);
	});

	pi.registerCommand("spawn", {
		description:
			"Spawn a managed tmux worker pane; child always starts with pi --session-control",
		handler: async (args, ctx) => {
			let request: SpawnRequest;
			try {
				request = parseSpawnCommandArgs(args ?? "");
			} catch (error: unknown) {
				const failure = toSpawnFailure(error);
				ctx.ui.notify(failure.error, "error");
				return;
			}

			const result = await runSpawnWorker(pi, ctx, request);
			if (result.ok) {
				ctx.ui.notify(result.message, "info");
				return;
			}

			ctx.ui.notify(result.error, "error");
		},
	});

	pi.registerCommand("workers", {
		description:
			"List known spawned workers for session-control orchestration.",
		handler: async (_args, ctx) => {
			const registry = loadRegistry(ctx);
			const namespace = loadState(ctx)?.workerNamespace;
			const output = buildWorkersListMessage(registry, namespace);
			ctx.ui.notify(output, registry.length === 0 ? "warning" : "info");
		},
	});

	pi.registerCommand("send-worker", {
		description:
			"Send to worker via session-control bridge first (not tmux keystrokes): /send-worker <target> <message>",
		handler: async (args, ctx) => {
			let request: SendWorkerRequest;
			try {
				request = parseSendWorkerCommandArgs(args ?? "");
			} catch (error: unknown) {
				const failure = toSpawnFailure(error);
				ctx.ui.notify(failure.error, "error");
				return;
			}

			const registry = loadRegistry(ctx);
			let worker: WorkerRecord;
			try {
				worker = resolveWorkerTarget(registry, request.target);
			} catch (error: unknown) {
				const failure = toSpawnFailure(error);
				ctx.ui.notify(failure.error, "error");
				return;
			}

			const result = await sendWorkerMessage(pi, worker.name, request.message);
			if (result.ok) {
				ctx.ui.notify(result.message, "info");
				return;
			}

			ctx.ui.notify(`${result.error}\n${result.fallback}`, "error");
		},
	});

	pi.registerTool({
		name: "spawn_worker",
		label: "Spawn Worker",
		description:
			"Spawn a managed child session in a new tmux pane. "
			+ "Child launch is always `pi --session-control`.",
		parameters: Type.Object({
			suffix: Type.Optional(Type.String()),
			split: Type.Optional(StringEnum(["v", "h"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let request: SpawnRequest;
			try {
				request = parseSpawnToolArgs(params);
			} catch (error: unknown) {
				const failure = toSpawnFailure(error);
				return {
					content: [{ type: "text", text: `Error: ${failure.error}` }],
					details: failure,
				};
			}

			const result = await runSpawnWorker(pi, ctx, request);
			if (result.ok) {
				return {
					content: [{ type: "text", text: result.message }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: `Error: ${result.error}` }],
				details: result,
			};
		},
	});
}
