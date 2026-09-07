#!/usr/bin/env python3
"""Aggregates local Claude Code usage (today + trailing 7 days) for the
claude-usage GNOME extension, by shelling out to the org-usage-metrics
plugin's own collector.py in --dry-run mode (no network, no server push).

`--delete <session_id>` permanently deletes that session's local transcript
(and enrichment files) before aggregating, so it disappears from this and
every future run. See delete_session().

Prints one JSON object to stdout: {"today": {...}, "week": {...}, "generated_at": ...}
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
    IST = ZoneInfo("Asia/Kolkata")
except ImportError:
    from datetime import timezone
    IST = timezone(timedelta(hours=5, minutes=30))

HOME = os.path.expanduser("~")
INSTALLED_DB = os.path.join(HOME, ".claude/plugins/installed_plugins.json")
MARKETPLACE_ROOT = os.path.join(
    HOME, ".claude/plugins/marketplaces/rently-awesome-copilot/plugins/org-usage-metrics"
)
PLUGIN_ID = "org-usage-metrics@rently-awesome-copilot"

CLAUDE_DIR = os.path.join(HOME, ".claude")
# Claude Code session IDs are UUIDs; this is also a path-traversal guard since
# session_id ends up in glob patterns and file paths below.
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def delete_session(session_id):
    """Permanently removes this session's local data: its transcript, any
    subagent transcripts filed under it, and its session-meta/facets
    enrichment. Does NOT touch the org-usage-metrics server -- a copy already
    pushed there survives this. Returns the list of paths removed."""
    if not SESSION_ID_RE.match(session_id):
        return []

    removed = []
    for path in glob.glob(os.path.join(CLAUDE_DIR, "projects", "*", f"{session_id}.jsonl")):
        os.remove(path)
        removed.append(path)
    for path in glob.glob(os.path.join(CLAUDE_DIR, "projects", "*", session_id)):
        if os.path.isdir(path):
            shutil.rmtree(path)
            removed.append(path)
    for sub in ("session-meta", "facets"):
        path = os.path.join(CLAUDE_DIR, "usage-data", sub, f"{session_id}.json")
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    return removed


def resolve_collector_path():
    """Same resolution strategy as the plugin's own launcher.sh: prefer the
    currently-installed version recorded by Claude Code, fall back to the
    marketplace checkout, so an upgrade is picked up automatically."""
    if os.path.exists(INSTALLED_DB):
        try:
            with open(INSTALLED_DB) as f:
                entries = json.load(f)["plugins"].get(PLUGIN_ID) or []
        except (OSError, ValueError, KeyError):
            entries = []
        best = None
        for entry in entries:
            root = entry.get("installPath")
            if not root or not os.path.isfile(os.path.join(root, "scripts", "collector.py")):
                continue
            stamp = entry.get("lastUpdated") or entry.get("installedAt") or ""
            if best is None or stamp > best[0]:
                best = (stamp, root)
        if best:
            return os.path.join(best[1], "scripts", "collector.py")

    fallback = os.path.join(MARKETPLACE_ROOT, "scripts", "collector.py")
    if os.path.isfile(fallback):
        return fallback
    return None


def collect_day(collector_path, date_str):
    try:
        out = subprocess.run(
            [sys.executable, collector_path, "--dry-run", "--no-pricing-fetch", "--date", date_str],
            capture_output=True, text=True, timeout=30,
        )
        return json.loads(out.stdout)
    except Exception:
        return None


def session_tokens(session):
    t = session.get("tokens") or {}
    return sum(t.get(k, 0) or 0 for k in
               ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"))


def summarize(sessions):
    cost = 0.0
    have_cost = False
    tokens = 0
    for s in sessions:
        if s.get("total_cost_usd") is not None:
            cost += s["total_cost_usd"]
            have_cost = True
        tokens += session_tokens(s)
    return {
        "sessions": len(sessions),
        "cost_usd": cost if have_cost else None,
        "tokens": tokens,
    }


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--delete":
        delete_session(sys.argv[2])

    collector_path = resolve_collector_path()
    if not collector_path:
        print(json.dumps({"error": "org-usage-metrics plugin not found"}))
        sys.exit(1)

    today = datetime.now(IST).date()
    dates = [(today - timedelta(days=i)).isoformat() for i in range(7)]

    all_sessions_by_day = {}
    for d in dates:
        payload = collect_day(collector_path, d)
        all_sessions_by_day[d] = (payload or {}).get("sessions") or []

    today_sessions = all_sessions_by_day[dates[0]]
    week_sessions = [s for day in dates for s in all_sessions_by_day[day]]

    today_summary = summarize(today_sessions)
    today_summary["date"] = dates[0]
    today_summary["tasks"] = [
        {
            "session_id": s.get("session_id"),
            "summary": s.get("task_summary") or s.get("repository") or "(untitled)",
            "repository": s.get("repository"),
            "cost_usd": s.get("total_cost_usd"),
            "tokens": session_tokens(s),
        }
        for s in today_sessions
    ]

    week_summary = summarize(week_sessions)
    week_summary["start_date"] = dates[-1]
    week_summary["end_date"] = dates[0]

    print(json.dumps({
        "today": today_summary,
        "week": week_summary,
        "generated_at": datetime.now(IST).isoformat(),
    }))


if __name__ == "__main__":
    main()
