/**
 * Pi Event Bus Extension
 *
 * Connects Pi sessions to the agent-event-bus for cross-session
 * communication and coordination between Pi and Claude Code sessions.
 *
 * Requires `agent-event-bus-cli` on PATH and a running event bus server.
 */

import type { ExtensionAPI, ExtensionContext, ExecResult } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EVENT_BUS_URL = process.env.AGENT_EVENT_BUS_URL ?? "http://127.0.0.1:8080/mcp";
const POLL_INTERVAL_MS = Number(process.env.PI_EVENT_BUS_POLL_INTERVAL ?? "30") * 1000;
const CLI = "agent-event-bus-cli";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileActivity {
	path: string;
	action: "write" | "edit";
}

interface BashActivity {
	command: string;
	exitCode: number;
	outputSnippet: string;
	isError: boolean;
}

interface TurnActivity {
	files: FileActivity[];
	bashCommands: BashActivity[];
	toolErrors: string[];
	toolCallCount: number;
}

interface ClassifiedEvent {
	eventType: string;
	payload: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface SessionState {
	sessionId: string;
	displayId: string;
	cursor: string;
}

let state: SessionState | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let currentCtx: ExtensionContext | undefined;
let cliAvailable = false;

let currentTurn: TurnActivity = freshTurn();
const pendingArgs = new Map<string, Record<string, unknown>>();

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

function freshTurn(): TurnActivity {
	return { files: [], bashCommands: [], toolErrors: [], toolCallCount: 0 };
}

function formatFiles(files: FileActivity[]): string {
	const unique = [...new Set(files.map((f) => f.path))];
	if (unique.length <= 3) return unique.join(", ");
	return `${unique.slice(0, 3).join(", ")} +${unique.length - 3} more`;
}

function truncate(s: string, max: number): string {
	const oneLine = s.replace(/\n/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}\u2026`;
}

function extractOutputSnippet(content: Array<{ type: string; text?: string }>): string {
	const text = content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	return lines.slice(-5).join("\n");
}

function parseJsonFromOutput(stdout: string): Record<string, unknown> | undefined {
	const text = stdout.trim();
	if (!text) return undefined;
	const jsonStart = text.search(/[{[]/);
	if (jsonStart === -1) return undefined;
	try {
		return JSON.parse(text.slice(jsonStart));
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyTurn(turn: TurnActivity): ClassifiedEvent | undefined {
	const { files, bashCommands, toolErrors, toolCallCount } = turn;

	const hasMutations = files.length > 0;
	const hasErrors = toolErrors.length > 0;
	const hasTestRun = bashCommands.some((b) =>
		/\b(test|spec|jest|vitest|pytest|cargo test|go test|npm run test|npx .*(vitest|jest))\b/i.test(b.command),
	);
	const hasTestFailure = bashCommands.some((b) =>
		/\b(test|spec|jest|vitest|pytest|cargo test|go test)\b/i.test(b.command) && b.isError,
	);
	const hasBuildOrLint = bashCommands.some((b) =>
		/\b(build|check|lint|tsc|eslint|biome|prettier)\b/i.test(b.command),
	);
	const hasBuildFailure = bashCommands.some((b) =>
		/\b(build|check|lint|tsc|eslint|biome)\b/i.test(b.command) && b.isError,
	);

	// Gotcha: test or build failure.
	if (hasTestFailure || hasBuildFailure) {
		const failedCmds = bashCommands.filter((b) => b.isError).map((b) => truncate(b.command, 60));
		const errorSnippets = bashCommands
			.filter((b) => b.isError && b.outputSnippet)
			.map((b) => truncate(b.outputSnippet, 120));
		const parts = [`failed: ${failedCmds.join(", ")}`, ...errorSnippets];
		if (files.length > 0) {
			parts.push(`while editing: ${formatFiles(files)}`);
		}
		return { eventType: "gotcha_discovered", payload: parts.join(" | ") };
	}

	// Tool errors with file mutations.
	if (hasErrors && hasMutations) {
		return {
			eventType: "error_pattern",
			payload: `${toolErrors.length} tool error(s) while editing ${formatFiles(files)}: ${toolErrors.map((e) => truncate(e, 80)).join("; ")}`,
		};
	}

	// Substantial work.
	if (hasMutations && (files.length >= 2 || hasTestRun || hasBuildOrLint || toolCallCount >= 5)) {
		const parts = [`edited ${formatFiles(files)}`];
		if (hasTestRun && !hasTestFailure) parts.push("tests passed");
		if (hasBuildOrLint && !hasBuildFailure) parts.push("build/lint clean");
		return { eventType: "task_completed", payload: parts.join(", ") };
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// CLI / Status Helpers
// ---------------------------------------------------------------------------

async function execCli(
	pi: ExtensionAPI,
	args: string[],
): Promise<ExecResult> {
	return pi.exec(CLI, ["--url", EVENT_BUS_URL, ...args], { timeout: 15_000 });
}

function parseJson(result: ExecResult): Record<string, unknown> | undefined {
	return parseJsonFromOutput(result.stdout);
}

function updateStatus(connected: boolean, extra?: string) {
	if (!currentCtx) return;
	if (!connected) {
		currentCtx.ui.setStatus("event-bus", "EB: disconnected");
		return;
	}
	const label = extra ? `EB: ${extra}` : `EB: ${state?.displayId ?? "connected"}`;
	currentCtx.ui.setStatus("event-bus", label);
}

// ---------------------------------------------------------------------------
// Registration / Unregistration
// ---------------------------------------------------------------------------

async function register(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
	const clientId = sessionFile ?? `pi-${process.pid}`;

	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5_000 });
	const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
	const dirName = ctx.cwd.split("/").pop() ?? "pi";
	const name = branch ? `${dirName}/${branch}` : dirName;

	const result = await execCli(pi, ["register", "--name", name, "--client-id", clientId]);
	if (result.code !== 0) {
		ctx.ui.notify(`Event bus: registration failed — ${result.stderr.trim() || "unknown error"}`, "warning");
		updateStatus(false);
		return false;
	}

	const data = parseJson(result);
	if (!data || typeof data.session_id !== "string") {
		ctx.ui.notify("Event bus: unexpected registration response", "warning");
		updateStatus(false);
		return false;
	}

	state = {
		sessionId: data.session_id as string,
		displayId: (data.display_id as string) ?? data.session_id as string,
		cursor: (data.cursor as string) ?? "0",
	};

	const resumed = data.resumed === true;
	const activeSessions = data.active_sessions as number | undefined;
	const statusExtra = activeSessions != null ? `${activeSessions} sessions` : undefined;

	updateStatus(true, statusExtra);

	const verb = resumed ? "Resumed" : "Registered";
	ctx.ui.notify(`Event bus: ${verb} as ${state.displayId}`, "info");
	return true;
}

async function unregister(pi: ExtensionAPI): Promise<void> {
	if (!state) return;
	try {
		await execCli(pi, ["unregister", "--session-id", state.sessionId]);
	} catch {
		// Best effort on shutdown.
	}
	state = undefined;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function poll(pi: ExtensionAPI): Promise<void> {
	if (!state || !currentCtx) return;

	const result = await execCli(pi, [
		"events",
		"--session-id", state.sessionId,
		"--resume",
		"--order", "asc",
		"--json",
		"--exclude", "session_registered,session_unregistered",
	]);

	if (result.code !== 0) {
		updateStatus(false);
		return;
	}

	const data = parseJson(result);
	if (!data) return;

	if (typeof data.next_cursor === "string") {
		state.cursor = data.next_cursor;
	}

	const events = data.events as Array<Record<string, unknown>> | undefined;
	if (!events || events.length === 0) {
		updateStatus(true);
		return;
	}

	for (const evt of events) {
		const eventType = evt.event_type as string ?? evt.type as string ?? "unknown";
		const sender = evt.session_display_id as string ?? evt.session_name as string ?? "unknown";
		const payload = evt.payload as string ?? "";
		const channel = evt.channel as string ?? "";

		const isDm = channel.startsWith("session:") && channel.includes(state.sessionId);
		const isRepoTargeted = channel.startsWith("repo:");
		const notifType = isDm ? "warning" as const : "info" as const;

		const prefix = isDm ? "[DM]" : isRepoTargeted ? `[${channel}]` : "[bus]";
		const line = `${prefix} ${sender}: ${eventType}${payload ? ` — ${payload}` : ""}`;

		currentCtx.ui.notify(line, notifType);
	}

	updateStatus(true);
}

function startPolling(pi: ExtensionAPI): void {
	stopPolling();
	poll(pi);
	pollTimer = setInterval(() => poll(pi), POLL_INTERVAL_MS);
}

function stopPolling(): void {
	if (pollTimer != null) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
}

// ---------------------------------------------------------------------------
// Auto-Publish
// ---------------------------------------------------------------------------

async function autoPublish(pi: ExtensionAPI, turn: TurnActivity): Promise<void> {
	if (!state || !cliAvailable) return;

	const classified = classifyTurn(turn);
	if (!classified) return;

	await execCli(pi, [
		"publish",
		"--type", classified.eventType,
		"--payload", classified.payload,
		"--channel", `repo:${currentCtx?.cwd.split("/").pop() ?? "unknown"}`,
		"--session-id", state.sessionId,
	]);
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		const check = await pi.exec("which", [CLI], { timeout: 5_000 });
		cliAvailable = check.code === 0;

		if (!cliAvailable) {
			ctx.ui.setStatus("event-bus", "EB: no CLI");
			return;
		}

		const ok = await register(pi, ctx);
		if (ok) {
			startPolling(pi);
		}
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		if (cliAvailable) {
			await unregister(pi);
		}
		currentCtx?.ui.setStatus("event-bus", undefined);
		currentCtx = undefined;
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopPolling();
		currentCtx = ctx;
		if (!cliAvailable) return;
		const ok = await register(pi, ctx);
		if (ok) {
			startPolling(pi);
		}
	});

	// ------------------------------------------------------------------
	// Turn Activity Tracking
	// ------------------------------------------------------------------

	pi.on("agent_start", async () => {
		currentTurn = freshTurn();
	});

	pi.on("tool_execution_start", async (event) => {
		pendingArgs.set(event.toolCallId, event.args ?? {});
	});

	pi.on("tool_execution_end", async (event) => {
		const args = pendingArgs.get(event.toolCallId) ?? {};
		pendingArgs.delete(event.toolCallId);
		currentTurn.toolCallCount++;

		if (event.isError) {
			const errorText = typeof event.result === "string"
				? event.result
				: event.result?.content?.[0]?.text ?? "unknown error";
			currentTurn.toolErrors.push(`${event.toolName}: ${errorText}`);
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = args.path as string | undefined;
			if (path) {
				currentTurn.files.push({ path, action: event.toolName as "write" | "edit" });
			}
		}

		if (event.toolName === "bash") {
			const command = args.command as string ?? "";
			const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
			const snippet = result?.content ? extractOutputSnippet(result.content) : "";
			currentTurn.bashCommands.push({
				command,
				exitCode: event.isError ? 1 : 0,
				outputSnippet: snippet,
				isError: event.isError,
			});
		}
	});

	pi.on("agent_end", async () => {
		await autoPublish(pi, currentTurn);
		currentTurn = freshTurn();
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	pi.registerCommand("broadcast", {
		description: "Publish a message to the event bus (usage: /broadcast [--channel <ch>] <message>)",
		handler: async (args, ctx) => {
			if (!cliAvailable) {
				ctx.ui.notify("Event bus CLI not found", "error");
				return;
			}
			if (!state) {
				ctx.ui.notify("Not connected to event bus", "error");
				return;
			}

			let channel = "all";
			let message = args.trim();
			const channelMatch = message.match(/^--channel\s+(\S+)\s+([\s\S]+)$/);
			if (channelMatch) {
				channel = channelMatch[1];
				message = channelMatch[2].trim();
			}

			if (!message) {
				ctx.ui.notify("Usage: /broadcast [--channel <ch>] <message>", "warning");
				return;
			}

			const result = await execCli(pi, [
				"publish",
				"--type", "user_broadcast",
				"--payload", message,
				"--channel", channel,
				"--session-id", state.sessionId,
			]);

			if (result.code === 0) {
				ctx.ui.notify(`Broadcast sent to ${channel}`, "info");
			} else {
				ctx.ui.notify(`Broadcast failed: ${result.stderr.trim()}`, "error");
			}
		},
	});

	pi.registerCommand("sessions", {
		description: "List active event bus sessions",
		handler: async (_args, ctx) => {
			if (!cliAvailable) {
				ctx.ui.notify("Event bus CLI not found", "error");
				return;
			}

			const result = await execCli(pi, ["sessions"]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed to list sessions: ${result.stderr.trim()}`, "error");
				return;
			}

			ctx.ui.notify(result.stdout.trim(), "info");
		},
	});

	pi.registerCommand("channels", {
		description: "List active event bus channels",
		handler: async (_args, ctx) => {
			if (!cliAvailable) {
				ctx.ui.notify("Event bus CLI not found", "error");
				return;
			}

			const result = await execCli(pi, ["channels"]);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed to list channels: ${result.stderr.trim()}`, "error");
				return;
			}

			ctx.ui.notify(result.stdout.trim(), "info");
		},
	});

	pi.registerCommand("events", {
		description: "Show recent event bus events (usage: /events [--limit N])",
		handler: async (args, ctx) => {
			if (!cliAvailable) {
				ctx.ui.notify("Event bus CLI not found", "error");
				return;
			}

			let limit = "20";
			const limitMatch = args.trim().match(/--limit\s+(\d+)/);
			if (limitMatch) {
				limit = limitMatch[1];
			}

			const cliArgs = ["events", "--json", "--limit", limit, "--order", "desc"];
			if (state) {
				cliArgs.push("--session-id", state.sessionId);
			}

			const result = await execCli(pi, cliArgs);
			if (result.code !== 0) {
				ctx.ui.notify(`Failed to fetch events: ${result.stderr.trim()}`, "error");
				return;
			}

			const data = parseJson(result);
			if (!data) {
				ctx.ui.notify("No events", "info");
				return;
			}

			const events = data.events as Array<Record<string, unknown>> | undefined;
			if (!events || events.length === 0) {
				ctx.ui.notify("No recent events", "info");
				return;
			}

			const lines = events.map((evt) => {
				const eventType = evt.event_type as string ?? evt.type as string ?? "?";
				const sender = evt.session_display_id as string ?? evt.session_name as string ?? "?";
				const payload = evt.payload as string ?? "";
				const channel = evt.channel as string ?? "";
				return `[${channel}] ${sender}: ${eventType}${payload ? ` — ${payload}` : ""}`;
			});

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("dm", {
		description: "Send a direct message to a session (usage: /dm <session-id> <message>)",
		handler: async (args, ctx) => {
			if (!cliAvailable) {
				ctx.ui.notify("Event bus CLI not found", "error");
				return;
			}
			if (!state) {
				ctx.ui.notify("Not connected to event bus", "error");
				return;
			}

			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /dm <session-id> <message>", "warning");
				return;
			}

			const targetSession = parts[0];
			const message = parts.slice(1).join(" ");

			const result = await execCli(pi, [
				"publish",
				"--type", "dm",
				"--payload", message,
				"--channel", `session:${targetSession}`,
				"--session-id", state.sessionId,
			]);

			if (result.code === 0) {
				ctx.ui.notify(`DM sent to ${targetSession}`, "info");
			} else {
				ctx.ui.notify(`DM failed: ${result.stderr.trim()}`, "error");
			}
		},
	});
}
