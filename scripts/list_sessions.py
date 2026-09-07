#!/usr/bin/env python3
"""Lists the most recently modified Claude Code sessions across all
projects, for the claude-suite GNOME extension's "Recent Sessions" menu.

Session files live at ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl.
We find the N newest by mtime (cheap: stat only), then fully parse just
those few files to pull out the real cwd (recorded per-record, since the
encoded directory name is lossy) and a human title -- Claude Code's own
"ai-title" summary when present, else the first user message.

Usage: list_sessions.py [--limit N]
Prints a JSON array to stdout, newest first:
  [{"session_id", "cwd", "title", "mtime", "mtime_str"}, ...]
"""
import glob
import json
import os
import sys
import time

HOME = os.path.expanduser("~")
PROJECTS_DIR = os.path.join(HOME, ".claude", "projects")


def relative_time(mtime):
    delta = time.time() - mtime
    if delta < 60:
        return "just now"
    if delta < 3600:
        mins = int(delta // 60)
        return f"{mins}m ago"
    if delta < 86400:
        hours = int(delta // 3600)
        return f"{hours}h ago"
    days = int(delta // 86400)
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days}d ago"
    return time.strftime("%Y-%m-%d", time.localtime(mtime))


def extract_session_info(path, mtime):
    session_id = os.path.splitext(os.path.basename(path))[0]
    cwd = None
    title = None
    first_user_text = None

    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if cwd is None and rec.get("cwd"):
                    cwd = rec["cwd"]

                if rec.get("type") == "ai-title" and rec.get("aiTitle"):
                    # Later titles supersede earlier ones as the session's
                    # topic settles, so keep scanning rather than break.
                    title = rec["aiTitle"]

                if first_user_text is None and rec.get("type") == "user":
                    content = rec.get("message", {}).get("content")
                    if isinstance(content, str):
                        first_user_text = content
                    elif isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                first_user_text = block.get("text")
                                break
    except OSError:
        return None

    if not title:
        title = (first_user_text or "(no messages)").strip().replace("\n", " ")
        if len(title) > 80:
            title = title[:77] + "..."

    return {
        "session_id": session_id,
        "cwd": cwd or HOME,
        "title": title or "(untitled session)",
        "mtime": mtime,
        "mtime_str": relative_time(mtime),
    }


def main():
    limit = 5
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        if idx + 1 < len(sys.argv):
            try:
                limit = int(sys.argv[idx + 1])
            except ValueError:
                pass

    candidates = []
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")):
        try:
            stat = os.stat(path)
        except OSError:
            continue
        if stat.st_size == 0:
            continue
        candidates.append((stat.st_mtime, path))

    candidates.sort(key=lambda pair: pair[0], reverse=True)

    sessions = []
    for mtime, path in candidates[:limit]:
        info = extract_session_info(path, mtime)
        if info:
            sessions.append(info)

    print(json.dumps(sessions))


if __name__ == "__main__":
    main()
