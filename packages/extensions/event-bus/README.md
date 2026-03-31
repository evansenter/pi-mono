# pi-event-bus

A [Pi Package](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) that connects Pi sessions to the [agent-event-bus](https://github.com/evansenter/agent-event-bus) for cross-session communication and coordination.

## Prerequisites

- [agent-event-bus](https://github.com/evansenter/agent-event-bus) server running
- [agent-event-bus-cli](https://github.com/evansenter/agent-event-bus) on PATH

## Installation

```bash
pi install git:github.com/evansenter/pi-event-bus
```

Or for project-local:

```bash
pi install git:github.com/evansenter/pi-event-bus -l
```

## What It Does

- **Auto-registers** your Pi session with the event bus on startup
- **Polls for events** every 30 seconds and shows notifications
- **Footer status** shows connection state (`EB: <display-id>` or `EB: disconnected`)
- **Direct messages** get highlighted as warnings for visibility

## Commands

| Command | Description |
|---------|-------------|
| `/broadcast <message>` | Send a message to all sessions |
| `/broadcast --channel repo:name <message>` | Send to a specific channel |
| `/sessions` | List active event bus sessions |
| `/channels` | List active channels |
| `/events [--limit N]` | Show recent events |
| `/dm <session-id> <message>` | Direct message a session |

## Auto-Publish

The extension automatically broadcasts events to the `repo:<name>` channel when meaningful work happens. It tracks tool calls during each agent turn and publishes only when the turn is significant:

| Event Type | Trigger |
|------------|--------|
| `task_completed` | Edited 2+ files, or edits with passing tests/build, or 5+ tool calls with mutations |
| `gotcha_discovered` | Test or build failure encountered during work |
| `error_pattern` | Tool errors (edit conflicts, write failures) while editing files |

Read-only turns, conversational responses, and trivial single-file edits are not published.

## Event Injection

The extension actively injects incoming events into the agent conversation rather than just showing notifications. When events arrive during polling, they are classified by urgency and dispatched accordingly.

### Event Priority Classification

| Priority | Dispatch | Event Types |
|----------|----------|-------------|
| IMMEDIATE | `sendMessage` + steer (interrupts current work) | `DM` (any channel targeting your session), `help_needed`, `blocker`, `gotcha_discovered`, `ci_failure` |
| NORMAL | `sendMessage` + followUp (queued until turn ends) | `task_completed`, `pattern_found`, `improvement_suggested`, `help_response`, `user_broadcast`, `rfc_created` |
| AMBIENT | `ui.notify` only (no conversation injection) | All other event types |

IMMEDIATE events wake the agent immediately — use them for urgent cross-session coordination. NORMAL events are held until the agent finishes its current turn to avoid interrupting mid-task. AMBIENT events surface as UI notifications and appear in `/events` history but do not enter the conversation.

### Adaptive Polling

The poller adjusts its interval based on agent activity:

- **5 seconds** while the agent is actively running (tool calls in flight)
- **30 seconds** when idle (configurable via `PI_EVENT_BUS_POLL_INTERVAL`)

This keeps latency low during collaborative work without hammering the bus when nothing is happening.

### Safety Mechanisms

To prevent runaway injection loops:

| Mechanism | Value | Description |
|-----------|-------|-------------|
| Cooldown | 30 s after each injection | No further injections until cooldown expires (max ~2/min) |
| TTL | 5 min | Events older than 5 minutes are skipped |
| Source filter | Drops own events | Events published by this session are never re-injected |
| Batch cap | 20 events / poll | Oldest events beyond the cap are skipped |

## Configuration

| Setting | Default | Env Var |
|---------|---------|---------|
| Event bus URL | `http://127.0.0.1:8080/mcp` | `AGENT_EVENT_BUS_URL` |
| Poll interval (idle) | 30s | `PI_EVENT_BUS_POLL_INTERVAL` |

## Session Lifecycle

- On `session_start`: registers with the event bus using a stable client ID derived from the Pi session file
- On `session_switch`: re-registers for the new session
- On `session_shutdown`: unregisters from the event bus
- On `/resume` or `-c`: re-registers with the same client ID, resuming from the last cursor (no missed events)

## License

MIT
