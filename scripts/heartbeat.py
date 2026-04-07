#!/usr/bin/env python3
import time
import re
import urllib.request
import urllib.error

CONF = "/home/regent/Developer/niri/home/heartbeat.conf"
TRIGGER = "http://localhost:3000/trigger/cron"
DEFAULT_INTERVAL = 100 # minutes


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
        req = urllib.request.Request(TRIGGER, method="POST")
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
