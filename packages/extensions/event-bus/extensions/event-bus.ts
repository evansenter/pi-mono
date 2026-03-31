/**
 * Pi Event Bus Extension
 *
 * Connects Pi sessions to the agent-event-bus for cross-session
 * communication and coordination between Pi and Claude Code sessions.
 *
 * Requires `agent-event-bus-cli` on PATH and a running event bus server.
 */

import type { ExtensionAPI, ExtensionContext, ExecResult } from "@mariozechner/pi-coding-agent";
import {
	classifyTurn, freshTurn,
	extractOutputSnippet, parseJsonFromOutput,
	classifyEventPriority, formatEventForAgent, isEventStale, buildBatchMessage,
	type TurnActivity, type BusEvent,
} from "../lib/classify.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EVENT_BUS_URL = process.env.AGENT_EVENT_BUS_URL ?? "http://127.0.0.1:8080/mcp";
const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = Number(process.env.PI_EVENT_BUS_POLL_INTERVAL ?? "30") * 1_000;
const INJECTION_COOLDOWN_MS = 30_000;
const MAX_INJECTIONS_PER_MINUTE = 3;
const EVENT_TTL_MS = 5 * 60 * 1_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1_000;
const MAX_BATCH_SIZE = 20;
const CLI = "agent-event-bus-cli";

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

let agentActive = false;
let lastInjectionTime = 0;
const recentInjectionTimes: number[] = [];
let injectedTurnActive = false;
let consecutiveFailures = 0;
let pendingBatchEvents: BusEvent[] = [];

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
		consecutiveFailures++;
		const backoffMs = Math.min(
			BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1),
			BACKOFF_MAX_MS,
		);
		updateStatus(false, `retry in ${Math.round(backoffMs / 1000)}s`);
		stopPolling();
		// Safe: if agent state changes during backoff, reschedulePolling clears this timer via stopPolling.
		backoffTimer = setTimeout(() => { backoffTimer = undefined; if (state) startPolling(pi); }, backoffMs);
		return;
	}

	const data = parseJson(result);
	if (!data) return;

	consecutiveFailures = 0;

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
		const eventSessionId = evt.session_id as string ?? "";

		// Source filtering: skip own events
		if (eventSessionId === state.sessionId) continue;

		// TTL filtering: skip stale events
		const rawTimestamp = evt.timestamp as number ?? 0;
		const timestampMs = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
		if (isEventStale(timestampMs, EVENT_TTL_MS)) continue;

		const isDm = channel.startsWith("session:") && channel.includes(state.sessionId);
		const priority = classifyEventPriority(eventType, isDm);

		if (priority === "ambient") {
			const isRepoTargeted = channel.startsWith("repo:");
			const notifType = isDm ? "warning" as const : "info" as const;
			const prefix = isDm ? "[DM]" : isRepoTargeted ? `[${channel}]` : "[bus]";
			const line = `${prefix} ${sender}: ${eventType}${payload ? ` — ${payload}` : ""}`;
			currentCtx.ui.notify(line, notifType);
		} else {
			pendingBatchEvents.push({ eventType, sender, payload, channel, timestampMs });
		}
	}

	flushInjections(pi);

	updateStatus(true);
}

let polling = false;
let backoffTimer: ReturnType<typeof setTimeout> | undefined;

function startPolling(pi: ExtensionAPI): void {
	stopPolling();
	void poll(pi).catch(() => {});
	pollTimer = setInterval(async () => {
		if (polling) return;
		polling = true;
		try { await poll(pi); } finally { polling = false; }
	}, agentActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

function stopPolling(): void {
	if (pollTimer != null) {
		clearInterval(pollTimer);
		pollTimer = undefined;
	}
	if (backoffTimer != null) {
		clearTimeout(backoffTimer);
		backoffTimer = undefined;
	}
}

function reschedulePolling(pi: ExtensionAPI): void {
	stopPolling();
	startPolling(pi);
}

// ---------------------------------------------------------------------------
// Auto-Publish
// ---------------------------------------------------------------------------

async function autoPublish(pi: ExtensionAPI, turn: TurnActivity): Promise<void> {
	// Skip auto-publish for turns triggered by event bus injection.
	// Relies on INJECTION_COOLDOWN_MS >= ACTIVE_POLL_MS to prevent double-set.
	if (injectedTurnActive) {
		injectedTurnActive = false;
		return;
	}
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

function flushInjections(pi: ExtensionAPI): void {
	if (pendingBatchEvents.length === 0 || !currentCtx) return;

	const now = Date.now();

	// Prune rate limit window
	const windowStart = now - 60_000;
	while (recentInjectionTimes.length > 0 && recentInjectionTimes[0] < windowStart) {
		recentInjectionTimes.shift();
	}

	// Rate limit check
	if (recentInjectionTimes.length >= MAX_INJECTIONS_PER_MINUTE) {
		currentCtx.ui.notify(
			`[Event Bus] Rate limited — ${pendingBatchEvents.length} event(s) buffered`,
			"warning",
		);
		return;
	}

	// Cooldown check
	if (now - lastInjectionTime < INJECTION_COOLDOWN_MS) {
		return;
	}

	// Cap batch size
	if (pendingBatchEvents.length > MAX_BATCH_SIZE) {
		currentCtx.ui.notify(
			`[Event Bus] Dropping ${pendingBatchEvents.length - MAX_BATCH_SIZE} oldest events (batch cap)`,
			"warning",
		);
		pendingBatchEvents = pendingBatchEvents.slice(-MAX_BATCH_SIZE);
	}

	// Determine highest priority in batch
	const hasImmediate = pendingBatchEvents.some((e) => {
		const isDm = e.channel.startsWith("session:") && state ? e.channel.includes(state.sessionId) : false;
		return classifyEventPriority(e.eventType, isDm) === "immediate";
	});

	const content = buildBatchMessage(pendingBatchEvents);
	const customType = hasImmediate ? "event-bus-urgent" : "event-bus-event";
	const deliverAs = hasImmediate ? "steer" as const : "followUp" as const;

	pi.sendMessage(
		{ customType, content, display: false },
		{ triggerTurn: true, deliverAs },
	);

	injectedTurnActive = true;
	lastInjectionTime = now;
	recentInjectionTimes.push(now);
	pendingBatchEvents = [];
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
		pendingBatchEvents = [];
		injectedTurnActive = false;
		consecutiveFailures = 0;
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
		agentActive = true;
		if (state && cliAvailable) reschedulePolling(pi);
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
		agentActive = false;
		if (state && cliAvailable) reschedulePolling(pi);
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
