/**
 * Integration tests for the event bus extension's push injection pipeline.
 *
 * Uses Pi's test harness with the faux LLM provider to verify the full
 * injection pipeline: external event -> poll -> classify -> sendMessage ->
 * agent wakes -> faux LLM responds.
 *
 * Prerequisites:
 * - `agent-event-bus-cli` must be on PATH
 * - Event bus server must be running at AGENT_EVENT_BUS_URL (default http://127.0.0.1:8080/mcp)
 */

// The extension reads PI_EVENT_BUS_POLL_INTERVAL at module scope as a const.
// We must set it before the module is loaded, then use dynamic import inside
// beforeAll so the env var takes effect. ESM import hoisting would defeat a
// static import placed after this assignment.
const savedPollInterval = process.env.PI_EVENT_BUS_POLL_INTERVAL;
process.env.PI_EVENT_BUS_POLL_INTERVAL = "1";

import { execSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createHarnessWithExtensions,
	type Harness,
} from "../../../coding-agent/test/test-harness.js";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EVENT_BUS_URL =
	process.env.AGENT_EVENT_BUS_URL ?? "http://127.0.0.1:8080/mcp";
const CLI = "agent-event-bus-cli";

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

let cliAvailable = false;
let busReachable = false;

try {
	execSync(`which ${CLI}`, { stdio: "ignore" });
	cliAvailable = true;
} catch {
	// CLI not installed
}

if (cliAvailable) {
	try {
		execSync(`${CLI} --url "${EVENT_BUS_URL}" sessions`, {
			timeout: 5_000,
			stdio: "ignore",
		});
		busReachable = true;
	} catch {
		// Server not reachable
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register a session with the event bus and return its session ID.
 */
function registerSession(
	name: string,
	clientId: string,
): { sessionId: string; displayId: string } {
	const result = execSync(
		[
			CLI,
			"--url",
			EVENT_BUS_URL,
			"register",
			"--name",
			name,
			"--client-id",
			clientId,
		]
			.map((s) => `"${s}"`)
			.join(" "),
		{ timeout: 5_000, encoding: "utf-8" },
	);
	const jsonMatch = result.match(/\{[\s\S]*\}/);
	if (!jsonMatch)
		throw new Error(`Failed to parse register output: ${result}`);
	const data = JSON.parse(jsonMatch[0]);
	return { sessionId: data.session_id, displayId: data.display_id };
}

/**
 * Unregister a session from the event bus (best effort).
 */
function unregisterSession(sessionId: string): void {
	try {
		execSync(
			`${CLI} --url "${EVENT_BUS_URL}" unregister --session-id "${sessionId}"`,
			{ timeout: 5_000, stdio: "ignore" },
		);
	} catch {
		// Best effort
	}
}

/**
 * Publish an event to the bus via the CLI.
 */
function publishEvent(opts: {
	type: string;
	payload: string;
	channel: string;
	sessionId: string;
}): void {
	execSync(
		[
			CLI,
			"--url",
			EVENT_BUS_URL,
			"publish",
			"--type",
			opts.type,
			"--payload",
			opts.payload,
			"--channel",
			opts.channel,
			"--session-id",
			opts.sessionId,
		]
			.map((s) => `"${s}"`)
			.join(" "),
		{ timeout: 5_000 },
	);
}

/**
 * Parse the session count from the human-readable `sessions` output.
 * Output format: "Active sessions (N):" on the first line.
 */
function getSessionCount(): number {
	const result = execSync(`${CLI} --url "${EVENT_BUS_URL}" sessions`, {
		timeout: 5_000,
		encoding: "utf-8",
	});
	const match = result.match(/Active sessions \((\d+)\)/);
	return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Wait for a condition to become true, polling at the given interval.
 */
async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
	const {
		timeoutMs = 10_000,
		intervalMs = 250,
		label = "condition",
	} = opts;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out waiting for: ${label}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!cliAvailable || !busReachable)(
	"event bus integration",
	() => {
		let harness: Harness;
		let eventBusExtension: ExtensionFactory;

		beforeAll(async () => {
			// Dynamic import ensures PI_EVENT_BUS_POLL_INTERVAL=1 is visible
			// when the extension module evaluates its module-level constants.
			vi.resetModules();
			const mod = await import("../extensions/event-bus.js");
			eventBusExtension = mod.default;
		});

		afterAll(() => {
			if (savedPollInterval !== undefined) {
				process.env.PI_EVENT_BUS_POLL_INTERVAL = savedPollInterval;
			} else {
				delete process.env.PI_EVENT_BUS_POLL_INTERVAL;
			}
		});

		afterEach(async () => {
			if (harness) {
				// Fire session_shutdown so the extension stops polling and unregisters
				const runner = harness.session.extensionRunner;
				if (runner?.hasHandlers("session_shutdown")) {
					await runner.emit({ type: "session_shutdown" });
				}
				harness.cleanup();
			}
		});

		it("registers with event bus on session start", async () => {
			const countBefore = getSessionCount();

			harness = await createHarnessWithExtensions({
				responses: ["ok"],
				extensionFactories: [eventBusExtension],
			});

			await harness.session.bindExtensions({});

			await waitFor(() => getSessionCount() > countBefore, {
				timeoutMs: 5_000,
				label: "session registration",
			});

			expect(getSessionCount()).toBeGreaterThan(countBefore);
		});

		it(
			"injects external event and triggers faux LLM response",
			async () => {
				harness = await createHarnessWithExtensions({
					responses: ["user reply", "event reply"],
					extensionFactories: [eventBusExtension],
				});

				await harness.session.bindExtensions({});

				await waitFor(() => getSessionCount() > 0, {
					timeoutMs: 5_000,
					label: "session registration",
				});

				// Send initial prompt so the session has context
				await harness.session.prompt("hello");
				expect(harness.faux.callCount).toBe(1);

				// Register a separate "sender" session to publish events from
				const uniqueClientId = `integration-test-sender-${Date.now()}`;
				const sender = registerSession("test-sender", uniqueClientId);

				try {
					// Publish a high-priority event to the repo channel.
					// help_needed is classified as "immediate" priority,
					// which triggers injection via steer delivery.
					const repoChan = `repo:${harness.tempDir.split("/").pop() ?? "unknown"}`;

					publishEvent({
						type: "help_needed",
						payload:
							"integration-test-marker: need help with tests",
						channel: repoChan,
						sessionId: sender.sessionId,
					});

					// Wait for the extension to poll, classify, and inject the event,
					// which triggers a new LLM turn via sendMessage.
					await waitFor(() => harness.faux.callCount >= 2, {
						timeoutMs: 15_000,
						intervalMs: 500,
						label: "faux LLM call from injected event",
					});

					expect(harness.faux.callCount).toBeGreaterThanOrEqual(2);

					// The custom message with the event content should appear in session messages
					const allMessages = harness.session.messages;
					const customMessages = allMessages.filter(
						(m) => m.role === "custom",
					);
					expect(customMessages.length).toBeGreaterThan(0);

					// At least one custom message should contain our marker
					const hasMarker = customMessages.some((m) => {
						const content =
							typeof m.content === "string"
								? m.content
								: JSON.stringify(m.content);
						return content.includes("integration-test-marker");
					});
					expect(hasMarker).toBe(true);

					// Verify the LLM responded to the injected event
					const assistantMessages = allMessages.filter(
						(m): m is AssistantMessage => m.role === "assistant",
					);
					expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
				} finally {
					unregisterSession(sender.sessionId);
				}
			},
			30_000,
		);

		it(
			"classifies ambient events as notifications only (no LLM turn)",
			async () => {
				harness = await createHarnessWithExtensions({
					responses: ["user reply"],
					extensionFactories: [eventBusExtension],
				});

				await harness.session.bindExtensions({});

				await waitFor(() => getSessionCount() > 0, {
					timeoutMs: 5_000,
					label: "session registration",
				});

				// Send initial prompt
				await harness.session.prompt("hello");
				const callCountAfterPrompt = harness.faux.callCount;
				expect(callCountAfterPrompt).toBe(1);

				// Register a sender
				const uniqueClientId = `integration-test-ambient-${Date.now()}`;
				const sender = registerSession(
					"ambient-sender",
					uniqueClientId,
				);

				try {
					// Publish an ambient event (session_heartbeat is classified as ambient)
					publishEvent({
						type: "session_heartbeat",
						payload: "ambient-test-marker",
						channel: "all",
						sessionId: sender.sessionId,
					});

					// Wait enough time for at least two poll cycles to pick it up
					await new Promise((r) => setTimeout(r, 3_000));

					// The faux LLM should NOT have been called again.
					// Ambient events produce UI notifications, not LLM turns.
					expect(harness.faux.callCount).toBe(callCountAfterPrompt);
				} finally {
					unregisterSession(sender.sessionId);
				}
			},
			15_000,
		);

		it(
			"unregisters from event bus on session shutdown",
			async () => {
				harness = await createHarnessWithExtensions({
					responses: ["ok"],
					extensionFactories: [eventBusExtension],
				});

				await harness.session.bindExtensions({});

				await waitFor(() => getSessionCount() > 0, {
					timeoutMs: 5_000,
					label: "session registration",
				});

				const countAfterReg = getSessionCount();

				// Emit session_shutdown to trigger unregister (dispose() alone doesn't fire it).
				// afterEach also does this, but the test needs to verify the count dropped.
				const runner = harness.session.extensionRunner;
				if (runner?.hasHandlers("session_shutdown")) {
					await runner.emit({ type: "session_shutdown" });
				}
				harness.cleanup();

				await waitFor(() => getSessionCount() < countAfterReg, {
					timeoutMs: 5_000,
					label: "session unregistration",
				});

				expect(getSessionCount()).toBeLessThan(countAfterReg);
			},
			15_000,
		);
	},
);
