#!/bin/bash
# E2E test for event bus push injection.
# Requires: agent-event-bus-cli on PATH, running event bus server, a Pi session with the extension loaded.
#
# Usage: ./e2e-injection.sh <pi-session-id>

set -euo pipefail

SESSION_ID="${1:?Usage: $0 <pi-session-id>}"
URL_ARGS=()
[[ -n "${AGENT_EVENT_BUS_URL:-}" ]] && URL_ARGS=(--url "$AGENT_EVENT_BUS_URL")

echo "=== E2E Injection Tests ==="
echo "Target session: $SESSION_ID"
echo ""

# Test 1: DM → should trigger IMMEDIATE injection
echo "[Test 1] Sending DM (help_needed) to session..."
agent-event-bus-cli ${URL_ARGS[@]+"${URL_ARGS[@]}"} publish \
    --type "help_needed" \
    --payload "E2E test: this should wake the agent (IMMEDIATE)" \
    --channel "session:${SESSION_ID}" \
    --session-id "e2e-test-runner"
echo "  Sent. Check Pi session — agent should wake and process this event."
echo ""
sleep 2

# Test 2: pattern_found → should trigger NORMAL injection
echo "[Test 2] Sending pattern_found to repo channel..."
REPO_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null || echo "unknown")
agent-event-bus-cli ${URL_ARGS[@]+"${URL_ARGS[@]}"} publish \
    --type "pattern_found" \
    --payload "E2E test: this should queue as followUp (NORMAL)" \
    --channel "repo:${REPO_NAME}" \
    --session-id "e2e-test-runner"
echo "  Sent. Check Pi session — should appear after current turn finishes."
echo ""
sleep 2

# Test 3: session_heartbeat → should be AMBIENT (notify only)
echo "[Test 3] Sending session_heartbeat (ambient)..."
agent-event-bus-cli ${URL_ARGS[@]+"${URL_ARGS[@]}"} publish \
    --type "session_heartbeat" \
    --payload "E2E test: this should only show as a notification" \
    --channel "all" \
    --session-id "e2e-test-runner"
echo "  Sent. Check Pi session — should appear as UI notification only, NOT in conversation."
echo ""

echo "=== Manual Verification ==="
echo "1. Did the Pi agent respond to the DM (Test 1)?"
echo "2. Did pattern_found appear in conversation after the turn (Test 2)?"
echo "3. Did session_heartbeat appear ONLY as a notification (Test 3)?"
echo ""
echo "If all 3 pass, push injection is working E2E."
