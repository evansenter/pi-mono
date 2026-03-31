# Event Bus

Use this skill when the user asks about cross-session communication, coordinating with other agents, broadcasting messages, checking what other sessions are doing, or sending direct messages to other sessions.

## Overview

The event bus extension connects this Pi session to the agent-event-bus, enabling real-time communication between multiple Pi sessions and Claude Code sessions.

## Available Commands

| Command | Description |
|---------|-------------|
| `/broadcast <message>` | Send a message to all connected sessions |
| `/broadcast --channel repo:name <message>` | Send to a specific channel |
| `/sessions` | List all active sessions on the event bus |
| `/channels` | List active channels |
| `/events` | Show recent events (default: 20) |
| `/events --limit 50` | Show more events |
| `/dm <session-id> <message>` | Send a direct message to a specific session |

## Channels

Sessions are automatically subscribed to:
- `all` — receives all broadcasts
- `session:<id>` — receives direct messages
- `repo:<name>` — receives repo-specific events
- `machine:<hostname>` — receives machine-specific events

## Event Types

Common event types you'll see:
- `user_broadcast` — manual broadcast from a user/agent
- `dm` — direct message to a specific session
- `session_registered` / `session_unregistered` — session lifecycle
- `task_completed` — agent finished a task
- `gotcha_discovered` — agent found a gotcha worth sharing

## Tips

- Use `/sessions` to find session IDs for `/dm`
- Broadcasts to `repo:<name>` reach all sessions working on that repo
- The extension polls every 30s by default (configurable via `PI_EVENT_BUS_POLL_INTERVAL`)
- The footer shows connection status: `EB: <display-id>` when connected, `EB: disconnected` otherwise
