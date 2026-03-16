/**
 * Session Move Extension
 *
 * Attribution: adapted from `extensions/move-session.ts` in
 * github.com/w-winter/dot314.
 *
 * Local changes in this variant are intentionally narrow:
 *  1) preserve `--session-control` when relaunching pi
 *  2) clean up the old session-control socket/alias state after handoff
 *
 * Move the current session into another cwd bucket and relaunch pi in that
 * directory.
 *
 * Implementation strategy:
 *  1) Fork the current session file into the target cwd bucket using
 *     SessionManager.forkFrom()
 *  2) Clear the fork header's parentSession pointer
 *  3) Tear down the parent's terminal usage (pop kitty protocol, reset modes)
 *  4) Spawn a new pi process in the target cwd with inherited stdio
 *  5) Once the child has spawned, trash the old session file
 *  6) Once the child has spawned, destroy the parent's stdin so it cannot
 *     steal key presses
 *  7) Parent stays alive as an inert wrapper, forwarding the child's exit code
 *
 * Usage:
 *   /move-session <targetCwd>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	closeSync,
	lstatSync,
	openSync,
	readSync,
	readdirSync,
	readlinkSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";

const TRASH_TIMEOUT_MS = 5000;
const HEADER_READ_MAX = 8192;
const COPY_CHUNK_SIZE = 65_536;
const CONTROL_DIR = join(homedir(), ".pi", "session-control");
const SOCKET_SUFFIX = ".sock";
const ALIAS_SUFFIX = ".alias";

/**
 * Remove parentSession from the first JSONL header line without loading
 * the entire file into memory.
 */
function clearParentSession(sessionFile: string): void {
	const fd = openSync(sessionFile, "r");
	const headerBuffer = Buffer.alloc(HEADER_READ_MAX);
	const bytesRead = readSync(fd, headerBuffer, 0, HEADER_READ_MAX, 0);
	const headerChunk = headerBuffer.toString("utf-8", 0, bytesRead);
	const newlineIndex = headerChunk.indexOf("\n");

	if (newlineIndex === -1) {
		closeSync(fd);
		return;
	}

	const header = JSON.parse(headerChunk.slice(0, newlineIndex));
	if (!header.parentSession) {
		closeSync(fd);
		return;
	}

	delete header.parentSession;
	const newHeaderLine = JSON.stringify(header) + "\n";
	const originalHeaderBytes = Buffer.byteLength(headerChunk.slice(0, newlineIndex + 1), "utf-8");

	const temporaryPath = sessionFile + ".move-session-tmp";
	let writeFd: number | undefined;
	try {
		writeFd = openSync(temporaryPath, "w");
		const newHeaderBuffer = Buffer.from(newHeaderLine, "utf-8");
		writeSync(writeFd, newHeaderBuffer, 0, newHeaderBuffer.length);

		const copyBuffer = Buffer.alloc(COPY_CHUNK_SIZE);
		let position = originalHeaderBytes;
		while (true) {
			const readCount = readSync(fd, copyBuffer, 0, COPY_CHUNK_SIZE, position);
			if (readCount === 0) break;
			writeSync(writeFd, copyBuffer, 0, readCount);
			position += readCount;
		}

		closeSync(writeFd);
		writeFd = undefined;
		closeSync(fd);
		renameSync(temporaryPath, sessionFile);
	} catch (error) {
		if (writeFd !== undefined) {
			try {
				closeSync(writeFd);
			} catch {
				// ignore cleanup close errors
			}
		}

		closeSync(fd);
		try {
			unlinkSync(temporaryPath);
		} catch {
			// ignore cleanup unlink errors
		}
		throw error;
	}
}

function isSessionControlEnabled(): boolean {
	return process.argv.slice(2).includes("--session-control");
}

function getSocketPath(sessionId: string): string {
	return join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}

function isSafeAlias(alias: string): boolean {
	return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}

function getAliasPath(alias: string): string {
	return join(CONTROL_DIR, `${alias}${ALIAS_SUFFIX}`);
}

/**
 * Best-effort cleanup of the old session-control state so the inert parent
 * cannot continue owning the alias/socket path after handoff.
 */
function cleanupOldSessionControl(sessionId: string, sessionName?: string): void {
	const socketPath = getSocketPath(sessionId);

	try {
		const entries = readdirSync(CONTROL_DIR);
		for (const entry of entries) {
			if (!entry.endsWith(ALIAS_SUFFIX)) continue;
			const aliasPath = join(CONTROL_DIR, entry);
			try {
				if (!lstatSync(aliasPath).isSymbolicLink()) continue;
				const target = readlinkSync(aliasPath);
				const resolvedTarget = resolve(CONTROL_DIR, target);
				if (resolvedTarget === socketPath) {
					unlinkSync(aliasPath);
				}
			} catch {
				// ignore alias cleanup errors
			}
		}
	} catch {
		// ignore missing/unreadable control dir
	}

	const alias = sessionName?.trim() ?? "";
	if (alias && isSafeAlias(alias)) {
		try {
			unlinkSync(getAliasPath(alias));
		} catch {
			// ignore alias cleanup errors
		}
	}

	try {
		unlinkSync(socketPath);
	} catch {
		// ignore socket cleanup errors
	}
}

function getChildArgs(destSessionFile: string): string[] {
	const args: string[] = [];
	if (isSessionControlEnabled()) {
		args.push("--session-control");
	}
	args.push("--session", destSessionFile);
	return args;
}

export default function (pi: ExtensionAPI) {
	const trashFileBestEffort = async (filePath: string) => {
		try {
			const { code } = await pi.exec("trash", [filePath], { timeout: TRASH_TIMEOUT_MS });
			if (code === 0) {
				return;
			}
		} catch {
			// ignore
		}

		// If "trash" isn't available, do not fall back to unlink.
		// This extension should never permanently delete session files.
	};

	pi.registerCommand("move-session", {
		description: "Move session to another directory and relaunch pi there",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const rawTargetCwd = args.trim();
			if (!rawTargetCwd) {
				ctx.ui.notify("Usage: /move-session <targetCwd>", "error");
				return;
			}

			let targetCwd = rawTargetCwd;
			if (/^~(?=$|\/)/.test(rawTargetCwd)) {
				const home = process.env.HOME || process.env.USERPROFILE;
				if (!home) {
					ctx.ui.notify("Cannot expand '~': $HOME is not set", "error");
					return;
				}
				targetCwd = rawTargetCwd.replace(/^~(?=$|\/)/, home);
			}
			targetCwd = resolve(targetCwd);

			let targetCwdStat;
			try {
				targetCwdStat = statSync(targetCwd);
			} catch (error: any) {
				const code = error?.code;
				if (code === "ENOENT") {
					ctx.ui.notify(`Path does not exist: ${targetCwd}`, "error");
				} else {
					ctx.ui.notify(`Cannot access path: ${targetCwd}`, "error");
				}
				return;
			}

			if (!targetCwdStat.isDirectory()) {
				ctx.ui.notify(`Not a directory: ${targetCwd}`, "error");
				return;
			}

			const sourceSessionFile = ctx.sessionManager.getSessionFile();
			if (!sourceSessionFile) {
				ctx.ui.notify("No persistent session file (maybe started with --no-session)", "error");
				return;
			}

			const sourceSessionId = ctx.sessionManager.getSessionId();
			const sourceSessionName = ctx.sessionManager.getSessionName();

			try {
				const forked = SessionManager.forkFrom(sourceSessionFile, targetCwd);
				const destSessionFile = forked.getSessionFile();

				if (!destSessionFile) {
					ctx.ui.notify("Internal error: forkFrom() produced no session file", "error");
					return;
				}

				// We intend to move/replace the original session, so avoid leaving
				// a parentSession pointer that may dangle after trashing the source.
				try {
					clearParentSession(destSessionFile);
				} catch (error: any) {
					ctx.ui.notify(
						`Warning: could not clear parent session reference: ${error?.message ?? String(error)}`,
						"warning",
					);
				}

				// --- Tear down the parent's terminal usage ---
				// We do this BEFORE spawning, to avoid nesting Kitty protocol flags.
				process.stdout.write("\x1b[<u");
				process.stdout.write("\x1b[?2004l");
				process.stdout.write("\x1b[?25h");
				process.stdout.write("\r\n");

				if (process.stdin.isTTY && process.stdin.setRawMode) {
					process.stdin.setRawMode(false);
				}

				const child = spawn("pi", getChildArgs(destSessionFile), {
					cwd: targetCwd,
					stdio: "inherit",
				});

				child.once("spawn", () => {
					if (isSessionControlEnabled()) {
						try {
							pi.setSessionName("");
						} catch {
							// ignore best-effort cleanup errors
						}
						try {
							cleanupOldSessionControl(sourceSessionId, sourceSessionName);
						} catch {
							// ignore best-effort cleanup errors
						}
					}

					void trashFileBestEffort(sourceSessionFile);

					process.stdin.removeAllListeners();
					process.stdin.destroy();

					process.removeAllListeners("SIGINT");
					process.removeAllListeners("SIGTERM");
					process.on("SIGINT", () => {});
					process.on("SIGTERM", () => {});
				});

				child.on("exit", (code) => process.exit(code ?? 0));
				child.on("error", (err) => {
					process.stderr.write(`Failed to launch pi: ${err.message}\n`);
					process.exit(1);
				});
			} catch (error: any) {
				ctx.ui.notify(`Failed to move session: ${error?.message ?? String(error)}`, "error");
			}
		},
	});
}
