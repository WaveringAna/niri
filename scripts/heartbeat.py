#!/usr/bin/env python3
import time
import re
import os
import urllib.request
import urllib.error

CONF = os.environ.get("NIRI_HEARTBEAT_CONF", "/home/regent/Developer/niri/home/heartbeat.conf")
SERVER = os.environ.get("NIRI_SERVER_URL", "http://localhost:3000").rstrip("/")
AGENT = os.environ.get("NIRI_AGENT_ID", "niri")
TRIGGER = f"{SERVER}/agents/{AGENT}/trigger/cron"
CONTROL_TOKEN = os.environ.get("NIRI_CONTROL_TOKEN", "").strip()
DEFAULT_INTERVAL = 100


def read_interval() -> int:
    try:
        with open(CONF) as f:
            content = f.read()
        match = re.search(r"^\d+$", content, re.MULTILINE)
        if match:
            return int(match.group())
    except OSError:
        pass
    return DEFAULT_INTERVAL


def trigger() -> bool:
    try:
        headers = {"Authorization": f"Bearer {CONTROL_TOKEN}"} if CONTROL_TOKEN else {}
        req = urllib.request.Request(TRIGGER, headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            return resp.status < 400
    except urllib.error.URLError:
        return False


if __name__ == "__main__":
    print("Heartbeat started. Press Ctrl+C to stop.")
    while True:
        interval = read_interval()
        success = trigger()
        status = "OK" if success else "FAILED"
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Trigger {status} — next in {interval}m")
        time.sleep(interval * 60)
