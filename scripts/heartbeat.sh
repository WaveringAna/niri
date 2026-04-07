#!/bin/bash
CONF="/home/regent/Developer/niri/home/heartbeat.conf"
TRIGGER="http://localhost:3000/trigger/cron"

INTERVAL=$(cat "$CONF" 2>/dev/null | grep -oE '^[0-9]+$' | head -1)
INTERVAL=${INTERVAL:-15}

curl -sf -X POST "$TRIGGER" >/dev/null 2>&1

sleep "${INTERVAL}m"
