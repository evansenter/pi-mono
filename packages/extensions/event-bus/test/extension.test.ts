/**
 * Integration tests for the extension's event wiring.
 *
 * Mocks the pi ExtensionAPI to verify that tool_execution_start args
 * are correctly correlated with tool_execution_end events, and that
 * auto-publish fires with the right classification.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock pi ExtensionAPI
// ---------------------------------------------------------------------------

interface MockHandler {
	event: string;
	handler: (...args: any[]) => Promise<any> | any;
}

interface MockCommand {
	name: string;
	options: { description?: string; handler: (args: string, ctx: any) => Promise<void> };
}

function createMockPi() {
	const handlers: MockHandler[] = [];
	const commands: MockCommand[] = [];
	const execCalls: Array<{ command: string; args: string[]; options?: any }> = [];

	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			handlers.push({ event, handler });
		},
		registerCommand(name: string, options: any) {
			commands.push({ name, options });
		},
		sendMessage: vi.fn(),
		exec: vi.fn(async (command: string, args: string[], options?: any) => {
			execCalls.push({ command, args, options });

			// Mock CLI responses
			if (command === "which") {
				return { stdout: "/usr/local/bin/agent-event-bus-cli", stderr: "", code: 0, killed: false };
			}
			if (command === "git") {
				return { stdout: "main", stderr: "", code: 0, killed: false };
			}
			if (args.includes("register")) {
				return {
					stdout: JSON.stringify({
						session_id: "test-session",
						display_id: "test-parrot",
						cursor: "0",
						active_sessions: 1,
						resumed: false,
					}),
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (args.includes("unregister")) {
				return { stdout: '{"success": true}', stderr: "", code: 0, killed: false };
			}
			if (args.includes("events")) {
				return { stdout: '{"events": [], "next_cursor": "0"}', stderr: "", code: 0, killed: false };
			}
			if (args.includes("publish")) {
				return { stdout: '{"ok": true}', stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		}),
		events: { on: vi.fn(), emit: vi.fn() },
	};

	function getHandler(event: string) {
		const h = handlers.find((h) => h.event === event);
		if (!h) throw new Error(`No handler for ${event}`);
		return h.handler;
	}

	function getAllHandlers(event: string) {
		return handlers.filter((h) => h.event === event).map((h) => h.handler);
	}

	return { pi, handlers, commands, execCalls, getHandler, getAllHandlers };
}

function createMockCtx(overrides: Record<string, any> = {}) {
	return {
		cwd: "/Users/test/projects/my-repo",
		sessionManager: {
			getSessionFile: () => "test-session-file",
			getEntries: () => [],
			getBranch: () => [],
		},
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
		isIdle: () => true,
		modelRegistry: {},
		model: undefined,
		hasUI: true,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extension event wiring", () => {
	let mock: ReturnType<typeof createMockPi>;
	let ctx: ReturnType<typeof createMockCtx>;

	beforeEach(async () => {
		// We need to re-import the extension each time to reset module state.
		// vitest module cache means we need to use dynamic import with cache busting.
		vi.resetModules();
		mock = createMockPi();
		ctx = createMockCtx();
	});

	async function loadExtension() {
		// Import the extension factory and call it with our mock
		const mod = await import("../extensions/event-bus.js");
		mod.default(mock.pi as any);
	}

	async function simulateSessionStart() {
		const sessionStartHandlers = mock.getAllHandlers("session_start");
		for (const h of sessionStartHandlers) {
			await h({}, ctx);
		}
	}

	it("registers handlers for all expected events", async () => {
		await loadExtension();
		const eventNames = mock.handlers.map((h) => h.event);
		expect(eventNames).toContain("session_start");
		expect(eventNames).toContain("session_shutdown");
		expect(eventNames).toContain("session_switch");
		expect(eventNames).toContain("agent_start");
		expect(eventNames).toContain("tool_execution_start");
		expect(eventNames).toContain("tool_execution_end");
		expect(eventNames).toContain("agent_end");
	});

	it("registers all commands", async () => {
		await loadExtension();
		const commandNames = mock.commands.map((c) => c.name);
		expect(commandNames).toContain("broadcast");
		expect(commandNames).toContain("sessions");
		expect(commandNames).toContain("channels");
		expect(commandNames).toContain("events");
		expect(commandNames).toContain("dm");
	});

	it("tracks write tool args from start to end", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		// Simulate two write tool calls
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "src/a.ts", content: "..." } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "write", args: { path: "src/b.ts", content: "..." } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		await agentEnd({});

		// Should have published a task_completed event
		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("task_completed"));
		expect(publishCall).toBeDefined();
		const payloadIndex = publishCall!.args.indexOf("--payload") + 1;
		expect(publishCall!.args[payloadIndex]).toContain("src/a.ts");
		expect(publishCall!.args[payloadIndex]).toContain("src/b.ts");
	});

	it("tracks edit tool args from start to end", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "src/x.ts", edits: [] } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "edit", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "edit", args: { path: "src/y.ts", edits: [] } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "edit", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("task_completed"));
		expect(publishCall).toBeDefined();
		const payloadIndex = publishCall!.args.indexOf("--payload") + 1;
		expect(publishCall!.args[payloadIndex]).toContain("src/x.ts");
		expect(publishCall!.args[payloadIndex]).toContain("src/y.ts");
	});

	it("tracks bash command args from start to end", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		// File edit + test run
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "src/foo.ts", content: "..." } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "bash", args: { command: "npm run test" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "bash", result: { content: [{ type: "text", text: "3 passed" }] }, isError: false });

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("task_completed"));
		expect(publishCall).toBeDefined();
		const payloadIndex = publishCall!.args.indexOf("--payload") + 1;
		expect(publishCall!.args[payloadIndex]).toContain("tests passed");
	});

	it("publishes gotcha_discovered on test failure", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "npx vitest --run" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: { content: [{ type: "text", text: "FAIL: expected 1 to be 2" }] }, isError: true });

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("gotcha_discovered"));
		expect(publishCall).toBeDefined();
	});

	it("publishes error_pattern on tool errors with file mutations", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		// Successful write
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "src/foo.ts", content: "..." } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		// Failed edit
		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "edit", args: { path: "src/foo.ts", edits: [] } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "edit", result: { content: [{ type: "text", text: "no unique match" }] }, isError: true });

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("error_pattern"));
		expect(publishCall).toBeDefined();
	});

	it("does not publish for read-only turns", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { path: "src/foo.ts" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] }, isError: false });

		// Clear exec calls from session_start registration
		mock.execCalls.length = 0;

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish"));
		expect(publishCall).toBeUndefined();
	});

	it("does not publish for single file edit without other signals", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});

		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "edit", args: { path: "src/foo.ts", edits: [] } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "edit", result: { content: [{ type: "text", text: "ok" }] }, isError: false });

		mock.execCalls.length = 0;

		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish"));
		expect(publishCall).toBeUndefined();
	});

	it("resets turn activity on agent_start", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		// First turn with writes
		await agentStart({});
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "a.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [] }, isError: false });
		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "write", args: { path: "b.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "write", result: { content: [] }, isError: false });
		await agentEnd({});

		// Second turn — read only
		await agentStart({});
		await toolStart({ type: "tool_execution_start", toolCallId: "tc3", toolName: "read", args: { path: "c.ts" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc3", toolName: "read", result: { content: [] }, isError: false });

		mock.execCalls.length = 0;
		await agentEnd({});

		// Should NOT publish — previous turn's files should be cleared
		const publishCall = mock.execCalls.find((c) => c.args.includes("publish"));
		expect(publishCall).toBeUndefined();
	});

	it("does not auto-publish on injected turn", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		// Set up exec to return a DM event on the next poll
		const originalExec = mock.pi.exec.getMockImplementation()!;
		let pollCount = 0;
		mock.pi.exec.mockImplementation(async (command: string, args: string[], options?: any) => {
			if (args.includes("events") && pollCount === 0) {
				pollCount++;
				return {
					stdout: JSON.stringify({
						events: [{
							event_type: "dm",
							session_display_id: "other-parrot",
							payload: "hey",
							channel: "session:test-session",
							session_id: "other-session",
							timestamp: Date.now() / 1000,
						}],
						next_cursor: "1",
					}),
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			return originalExec(command, args, options);
		});

		// Trigger a poll by starting/stopping polling (which fires immediate poll)
		await agentStart({});

		// Wait a tick for the poll to resolve
		await new Promise((r) => setTimeout(r, 50));

		// sendMessage should have been called with the DM
		expect(mock.pi.sendMessage).toHaveBeenCalled();

		// Now simulate agent_end — should NOT auto-publish because injectedTurnActive is true
		// First add some file writes to make it look like a real turn
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "a.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [] }, isError: false });
		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "write", args: { path: "b.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "write", result: { content: [] }, isError: false });

		mock.execCalls.length = 0;
		await agentEnd({});

		// Should NOT have published because injectedTurnActive suppresses it
		const publishCall = mock.execCalls.find((c) => c.args.includes("publish"));
		expect(publishCall).toBeUndefined();
	});

	it("publishes to repo channel derived from cwd", async () => {
		await loadExtension();
		await simulateSessionStart();

		const agentStart = mock.getHandler("agent_start");
		const toolStart = mock.getHandler("tool_execution_start");
		const toolEnd = mock.getHandler("tool_execution_end");
		const agentEnd = mock.getHandler("agent_end");

		await agentStart({});
		await toolStart({ type: "tool_execution_start", toolCallId: "tc1", toolName: "write", args: { path: "a.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc1", toolName: "write", result: { content: [] }, isError: false });
		await toolStart({ type: "tool_execution_start", toolCallId: "tc2", toolName: "write", args: { path: "b.ts", content: "" } });
		await toolEnd({ type: "tool_execution_end", toolCallId: "tc2", toolName: "write", result: { content: [] }, isError: false });
		await agentEnd({});

		const publishCall = mock.execCalls.find((c) => c.args.includes("publish") && c.args.includes("task_completed"));
		expect(publishCall).toBeDefined();
		const channelIndex = publishCall!.args.indexOf("--channel") + 1;
		expect(publishCall!.args[channelIndex]).toBe("repo:my-repo");
	});
});

// ---------------------------------------------------------------------------
// Injection Dispatch Tests
// ---------------------------------------------------------------------------

describe("injection dispatch", () => {
	let mock: ReturnType<typeof createMockPi>;
	let ctx: ReturnType<typeof createMockCtx>;

	beforeEach(async () => {
		vi.resetModules();
		mock = createMockPi();
		ctx = createMockCtx();
	});

	async function loadExtension() {
		const mod = await import("../extensions/event-bus.js");
		mod.default(mock.pi as any);
	}

	async function simulateSessionStart() {
		const sessionStartHandlers = mock.handlers.filter((h) => h.event === "session_start").map((h) => h.handler);
		for (const h of sessionStartHandlers) {
			await h({}, ctx);
		}
	}

	function makeEventsResponse(events: Array<Record<string, unknown>>) {
		return {
			stdout: JSON.stringify({ events, next_cursor: "1" }),
			stderr: "",
			code: 0,
			killed: false,
		};
	}

	function setupEventsExec(events: Array<Record<string, unknown>>) {
		const originalExec = mock.pi.exec.getMockImplementation()!;
		let served = false;
		mock.pi.exec.mockImplementation(async (command: string, args: string[], options?: any) => {
			if (args.includes("events") && !served) {
				served = true;
				return makeEventsResponse(events);
			}
			return originalExec(command, args, options);
		});
	}

	it("dispatches DM events as urgent with steer", async () => {
		await loadExtension();
		await simulateSessionStart();

		setupEventsExec([{
			event_type: "dm",
			session_display_id: "sender-parrot",
			payload: "hello there",
			channel: "session:test-session",
			session_id: "other-session",
			timestamp: Date.now() / 1000,
		}]);

		const agentStart = mock.handlers.find((h) => h.event === "agent_start")!.handler;
		await agentStart({});
		await new Promise((r) => setTimeout(r, 50));

		expect(mock.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "event-bus-urgent", display: false }),
			expect.objectContaining({ triggerTurn: true, deliverAs: "steer" }),
		);
	});

	it("dispatches pattern_found as normal with followUp", async () => {
		await loadExtension();
		await simulateSessionStart();

		setupEventsExec([{
			event_type: "pattern_found",
			session_display_id: "sender-parrot",
			payload: "found a pattern",
			channel: "repo:my-repo",
			session_id: "other-session",
			timestamp: Date.now() / 1000,
		}]);

		const agentStart = mock.handlers.find((h) => h.event === "agent_start")!.handler;
		await agentStart({});
		await new Promise((r) => setTimeout(r, 50));

		expect(mock.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "event-bus-event", display: false }),
			expect.objectContaining({ triggerTurn: true, deliverAs: "followUp" }),
		);
	});

	it("dispatches session_heartbeat as ambient notification only", async () => {
		await loadExtension();
		await simulateSessionStart();

		setupEventsExec([{
			event_type: "session_heartbeat",
			session_display_id: "sender-parrot",
			payload: "",
			channel: "all",
			session_id: "other-session",
			timestamp: Date.now() / 1000,
		}]);

		const agentStart = mock.handlers.find((h) => h.event === "agent_start")!.handler;
		await agentStart({});
		await new Promise((r) => setTimeout(r, 50));

		// Should NOT call sendMessage for ambient events
		expect(mock.pi.sendMessage).not.toHaveBeenCalled();
		// Should call notify
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("session_heartbeat"),
			"info",
		);
	});

	it("skips own session events", async () => {
		await loadExtension();
		await simulateSessionStart();

		setupEventsExec([{
			event_type: "task_completed",
			session_display_id: "test-parrot",
			payload: "did stuff",
			channel: "repo:my-repo",
			session_id: "test-session", // Same as our session
			timestamp: Date.now() / 1000,
		}]);

		// Clear notify calls from session_start
		ctx.ui.notify.mockClear();

		const agentStart = mock.handlers.find((h) => h.event === "agent_start")!.handler;
		await agentStart({});
		await new Promise((r) => setTimeout(r, 50));

		expect(mock.pi.sendMessage).not.toHaveBeenCalled();
		// notify should not have been called with our event
		const notifyCalls = ctx.ui.notify.mock.calls;
		const eventNotify = notifyCalls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("task_completed"));
		expect(eventNotify).toBeUndefined();
	});

	it("skips stale events", async () => {
		await loadExtension();
		await simulateSessionStart();

		// Timestamp from 10 minutes ago (beyond 5min TTL)
		const staleTimestamp = (Date.now() - 10 * 60 * 1000) / 1000;

		setupEventsExec([{
			event_type: "task_completed",
			session_display_id: "sender-parrot",
			payload: "old stuff",
			channel: "repo:my-repo",
			session_id: "other-session",
			timestamp: staleTimestamp,
		}]);

		ctx.ui.notify.mockClear();

		const agentStart = mock.handlers.find((h) => h.event === "agent_start")!.handler;
		await agentStart({});
		await new Promise((r) => setTimeout(r, 50));

		expect(mock.pi.sendMessage).not.toHaveBeenCalled();
		const notifyCalls = ctx.ui.notify.mock.calls;
		const eventNotify = notifyCalls.find((c: any[]) => typeof c[0] === "string" && c[0].includes("task_completed"));
		expect(eventNotify).toBeUndefined();
	});
});
