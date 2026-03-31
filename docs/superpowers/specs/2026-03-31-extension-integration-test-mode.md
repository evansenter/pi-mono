# Extension Integration Test Mode

## Problem

Pi's test harness (`createHarnessWithExtensions`) mocks all `pi.exec` calls, making it impossible to test extensions that depend on external services via CLI tools. The event bus extension shells out to `agent-event-bus-cli` for registration, polling, and publishing. To verify the full injection pipeline (external event -> poll -> classify -> sendMessage -> agent wakes -> responds), we need real CLI calls to reach the event bus server while keeping the LLM mocked via the faux provider.

## Design

### Selective exec passthrough

Add an `execPassthrough` option to the test harness that allows specific CLI commands to execute for real while keeping everything else mocked:

```typescript
const harness = await createHarnessWithExtensions({
  responses: [
    fauxAssistantMessage("I received an event from the bus, acknowledged."),
  ],
  extensionFactories: [eventBusExtensionFactory],
  execPassthrough: (command: string, args: string[]) => {
    return command === "agent-event-bus-cli" || command === "which";
  },
});
```

### How it works

The harness wraps `pi.exec` with a mock. Currently, all calls hit the mock unconditionally. With `execPassthrough`, the mock checks the predicate first:

```typescript
exec: vi.fn(async (command: string, args: string[], options?: ExecOptions) => {
  // If passthrough matches, execute for real
  if (execPassthrough?.(command, args)) {
    return realExec(command, args, options);
  }
  // Otherwise, return mock response
  return mockExecHandler(command, args, options);
}),
```

`realExec` delegates to Node's `child_process.execFile` with the same timeout/signal semantics as Pi's production exec. The return type matches Pi's `ExecResult` interface: `{ stdout, stderr, code, killed }`.

### What changes in packages/coding-agent

**File: `packages/coding-agent/test/test-harness.ts`**

1. Add `execPassthrough` to `HarnessOptions`:
```typescript
interface HarnessOptions {
  // ... existing options
  execPassthrough?: (command: string, args: string[]) => boolean;
}
```

2. Add `realExec` helper function that wraps `child_process.execFile` into Pi's `ExecResult` format.

3. Modify the exec mock in `createHarnessWithResourceLoader` to check `execPassthrough` before returning mock data.

### What changes in packages/extensions/event-bus

**File: `packages/extensions/event-bus/test/integration.test.ts`** (new)

Integration tests that exercise the full pipeline:

```typescript
describe("event bus integration", () => {
  it("injects DM event and agent responds via faux provider", async () => {
    const harness = await createHarnessWithExtensions({
      responses: [
        fauxAssistantMessage("Acknowledged the event bus message."),
      ],
      extensionFactories: [eventBusExtensionFactory],
      execPassthrough: (cmd) => cmd === "agent-event-bus-cli" || cmd === "which",
    });

    // 1. Start session — extension registers with real event bus
    await harness.emitSessionStart();

    // 2. Verify registration happened
    const sessions = await listEventBusSessions();
    expect(sessions).toContainEqual(expect.objectContaining({
      name: expect.stringContaining("test"),
    }));

    // 3. Send DM event from outside
    const sessionId = harness.getExtensionSessionId();
    await sendTestEvent({
      type: "help_needed",
      payload: "integration test: please respond",
      channel: `session:${sessionId}`,
      sessionId: "test-sender",
    });

    // 4. Trigger poll (or wait for interval)
    await harness.triggerPoll();

    // 5. Verify sendMessage was called with steer delivery
    expect(harness.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "event-bus-urgent",
        display: false,
      }),
      expect.objectContaining({
        triggerTurn: true,
        deliverAs: "steer",
      }),
    );

    // 6. Verify faux LLM was invoked (agent woke up)
    expect(harness.faux.callCount).toBe(1);

    // 7. Verify the injected content reached the LLM context
    const lastContext = harness.faux.lastContext();
    const injectedMessage = lastContext.find(m =>
      m.content?.includes("[Event Bus]") && m.content?.includes("help_needed"),
    );
    expect(injectedMessage).toBeDefined();

    // 8. Cleanup
    await harness.emitSessionShutdown();
    harness.cleanup();
  });

  it("classifies pattern_found as NORMAL with followUp delivery", async () => {
    // Similar structure, different event type, assert followUp
  });

  it("does not inject ambient events into agent context", async () => {
    // Send session_heartbeat, verify sendMessage NOT called, notify IS called
  });

  it("filters own-session events", async () => {
    // Send event with same session_id, verify skipped
  });

  it("filters stale events beyond TTL", async () => {
    // Send event with old timestamp, verify skipped
  });
});
```

### Test helpers

Small utilities for the integration tests, colocated in the test file or a `test/helpers.ts`:

```typescript
// Shell out to agent-event-bus-cli for test setup/teardown
async function sendTestEvent(opts: {
  type: string; payload: string; channel: string; sessionId: string;
}): Promise<void> {
  await execAsync("agent-event-bus-cli", [
    "--url", process.env.AGENT_EVENT_BUS_URL ?? "http://127.0.0.1:8080/mcp",
    "publish",
    "--type", opts.type,
    "--payload", opts.payload,
    "--channel", opts.channel,
    "--session-id", opts.sessionId,
  ]);
}

async function listEventBusSessions(): Promise<Array<{ session_id: string; name: string }>> {
  const result = await execAsync("agent-event-bus-cli", [
    "--url", process.env.AGENT_EVENT_BUS_URL ?? "http://127.0.0.1:8080/mcp",
    "sessions", "--json",
  ]);
  return JSON.parse(result.stdout).result;
}
```

### Triggering poll manually

The event bus extension uses `setInterval` for polling. In tests, we don't want to wait 5-30 seconds. Options:

1. **vi.useFakeTimers** — advance time to trigger the interval. But real exec calls use real timers, so fake timers would break CLI execution.

2. **Export a poll trigger** — the extension could export a `__testPollNow` function when `process.env.NODE_ENV === "test"`. But this pollutes the production API.

3. **Short poll interval via env var** — set `PI_EVENT_BUS_POLL_INTERVAL=1` (1 second) in the test, then `await sleep(1500)`. The extension already reads this env var.

**Recommendation:** Option 3 — set the env var to 1 second. The test waits ~1.5s for a poll cycle. Simple, no production code changes, realistic.

### Prerequisites

- `agent-event-bus-cli` installed on the test machine
- Event bus server running at `AGENT_EVENT_BUS_URL` (default localhost:8080)
- Tests skip gracefully if either is unavailable (like the `ai` package's `describe.skipIf(!process.env.API_KEY)` pattern)

### Skip guard

```typescript
const CLI_AVAILABLE = await which("agent-event-bus-cli").then(() => true).catch(() => false);
const BUS_REACHABLE = await fetch(EVENT_BUS_URL + "/health").then(r => r.ok).catch(() => false);

describe.skipIf(!CLI_AVAILABLE || !BUS_REACHABLE)("event bus integration", () => {
  // ...
});
```

## Scope

### In scope
- `execPassthrough` option on `HarnessOptions`
- `realExec` helper in test-harness.ts
- Integration test file for event bus extension
- Test helpers for sending events and querying sessions

### Out of scope
- Event bus server lifecycle management (start/stop from tests)
- Multi-session coordination tests (two harnesses talking to each other)
- SSE-based tests (Phase 4 of the injection RFC)
- Changes to the faux provider itself (it already supports everything we need)

## Testing

The integration tests themselves ARE the test for this feature. Meta-verification:
- Run `npx vitest --run test/integration.test.ts` in the event-bus package
- With event bus running: tests execute and verify the full pipeline
- Without event bus: tests skip gracefully with a clear message

## Files changed

| File | Change |
|------|--------|
| `packages/coding-agent/test/test-harness.ts` | Add `execPassthrough` option, `realExec` helper |
| `packages/extensions/event-bus/test/integration.test.ts` | New: full pipeline integration tests |
| `packages/extensions/event-bus/package.json` | Add `@mariozechner/pi-coding-agent` as dev dependency (for harness import) |
