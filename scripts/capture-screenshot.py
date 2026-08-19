#!/usr/bin/env python3
"""Capture a faithful text screenshot of the TUI by replaying its PTY output
through a real terminal emulator (pyte).

Usage:  python3 scripts/capture-screenshot.py [--profile dsh-cctui] [--prompt "..."]

Writes the rendered screen to stdout. Home paths are replaced with `~` so a
capture can be pasted publicly.
"""
import argparse
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

try:
    import pyte
except ImportError:  # pragma: no cover - helpful message beats a stack trace
    sys.exit("this script needs pyte:  pip install pyte")

COLS, ROWS = 100, 44


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="dsh-cctui")
    ap.add_argument("--prompt", default=None, help="send this prompt and wait for a reply")
    ap.add_argument("--cwd", default=os.path.expanduser("~/workspace/dsh-ccTUI"))
    ap.add_argument("--wait", type=float, default=90.0)
    args = ap.parse_args()

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    os.set_inheritable(slave, True)
    env = dict(os.environ)
    env["NODE_ENV"] = "production"
    proc = subprocess.Popen(
        ["dsh", "--profile", args.profile],
        stdin=slave, stdout=slave, stderr=slave,
        env=env, cwd=args.cwd, close_fds=True, preexec_fn=os.setsid,
    )
    os.close(slave)

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    def pump(needles, timeout):
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.25)
            if master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                stream.feed(chunk)
                replies = []
                if b"\x1b[c" in chunk:
                    replies.append(b"\x1b[?62;22c")
                for _ in re.findall(rb"\x1b\[6n", chunk):
                    replies.append(b"\x1b[40;1R")
                if b"\x1b]11;?" in chunk:
                    replies.append(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\")
                if b"\x1b[?2026$p" in chunk:
                    replies.append(b"\x1b[?2026;2$y")
                if replies:
                    os.write(master, b"".join(replies))
            text = "\n".join(screen.display)
            if any(n in text for n in needles):
                return True
            if proc.poll() is not None:
                break
        return any(n in "\n".join(screen.display) for n in needles)

    try:
        if not pump(["❯"], args.wait):
            return 2
        pump([], 1.5)
        if args.prompt:
            os.write(master, args.prompt.encode())
            pump([], 0.6)
            os.write(master, b"\r")
            pump(["⏺"], args.wait)
            # wait for the turn to finish: the footer returns to its idle hint
            deadline = time.time() + args.wait
            while time.time() < deadline:
                pump([], 1.0)
                display = "\n".join(screen.display)
                if "? for shortcuts" in display and "esc to interrupt" not in display:
                    break
            pump([], 1.0)
        out = "\n".join(screen.display)
        os.write(master, b"/quit")
        pump([], 0.4)
        os.write(master, b"\x1b")
        pump([], 0.3)
        os.write(master, b"\r")
        pump([], 1.5)
    finally:
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            os.close(master)
        except OSError:
            pass

    print(render(out))
    return 0


def render(out: str) -> str:
    """Sanitize home paths without breaking the panel's box alignment, and drop
    any leading terminal-query echo."""
    home = os.path.expanduser("~")
    user = os.path.basename(home)
    # Width-preserving substitution: pad right where the token shrank, so the
    # panel's inner column borders stay put.
    def shrink(match: "re.Match[str]") -> str:
        replaced = "~" + match.group(0)[len(home):]
        return replaced + " " * (len(match.group(0)) - len(replaced))

    lines = []
    for line in out.split("\n"):
        if home in line:
            line = re.sub(re.escape(home) + r"[^\s│]*", shrink, line)
        if user in line:
            line = re.sub(
                re.escape(user),
                lambda m: "you" + " " * (len(user) - 3) if len(user) >= 3 else m.group(0),
                line,
            )
        lines.append(line.rstrip())
    while lines and not lines[0].strip():
        lines.pop(0)
    # the first line can carry a stray reply to our own DA1/CPR answers
    if lines and len(lines[0].strip()) <= 3 and "█" not in lines[0]:
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
