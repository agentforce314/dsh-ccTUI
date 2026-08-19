#!/usr/bin/env python3
"""Render one harness tool per boot and dump the trail it produced.

The transcript's tool rows are the hardest part of the port to eyeball: every
tool reaches `⏺ Tool(args)` / `⎿ result` through a different presentation card,
and a regression in one of them is invisible while the other twenty look fine.
This drives the REAL dsh (from node_modules) with the real cctui plugin and a
scripted LLM (test/e2e/probe-llm.mjs) that turns a `PROBE <tool> <json>` prompt
into exactly that tool call — no network, no credentials, no model deciding to
do something else — then replays the PTY through a terminal emulator and prints
the screen.

    python3 scripts/tool-gallery.py                 # every scenario
    python3 scripts/tool-gallery.py read grep       # a couple
    python3 scripts/tool-gallery.py read --expand   # ctrl+o detail rows

Pair a capture with the same call made to Claude Code to see what still differs.
Needs pyte:  pip install pyte
"""
import argparse
import fcntl
import json
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
from pathlib import Path

try:
    import pyte
except ImportError:  # pragma: no cover - helpful message beats a stack trace
    sys.exit("this script needs pyte:  pip install pyte")

ROOT = Path(__file__).resolve().parents[1]
HOME = ROOT / ".dsh-dev-home" / "gallery"
PROFILE = HOME / "profiles" / "gallery"
PATCH = HOME / "gallery.cordis.yml"
COLS, ROWS = 120, 46

PROMPT_GLYPH = "❯"
TOOL_GLYPH = "⏺"

# One entry per tool shape worth watching. A list runs several turns and
# captures after the last — `edit` needs its file read first, because the
# harness refuses to edit a file this session has not observed.
SCENARIOS: dict[str, object] = {
    "read": 'PROBE read {"file_path": "src/domain/usage.ts"}',
    "read_window": 'PROBE read {"file_path": "src/domain/toolBrief.ts", "offset": 60, "limit": 30}',
    "read_missing": 'PROBE read {"file_path": "src/does-not-exist.ts"}',
    "grep": 'PROBE grep {"pattern": "presentResult", "path": "src"}',
    "grep_empty": 'PROBE grep {"pattern": "zzzz-no-such-token-zzzz", "path": "src"}',
    "glob": 'PROBE glob {"pattern": "src/components/*.tsx"}',
    "bash": 'PROBE bash {"command": "ls -1 src | head -12", "description": "list src"}',
    "bash_fail": 'PROBE bash {"command": "ls /no/such/dir", "description": "failing ls"}',
    "write": 'PROBE write {"file_path": "e2e-scratch/gallery-write.txt", "content": "alpha\\nbeta\\ngamma\\n"}',
    # the harness refuses to edit a file this session has not observed, so the
    # scenario writes it, reads it, then edits it
    "edit": [
        'PROBE write {"file_path": "e2e-scratch/gallery-edit.txt", "content": "alpha\\nbeta\\ngamma\\n"}',
        'PROBE read {"file_path": "e2e-scratch/gallery-edit.txt"}',
        'PROBE edit {"file_path": "e2e-scratch/gallery-edit.txt", "old_string": "beta", "new_string": "BETA-changed"}',
    ],
    # reaches the network on purpose — the fetch card is a retrieval summary
    "web_fetch": 'PROBE web_fetch {"url": "https://example.com"}',
    "web_search": 'PROBE web_search {"query": "deepseek harness"}',
    "subagent": (
        'PROBE subagent {"description": "Review the diff", "prompt": "Summarise what changed in src/ and stop.",'
        ' "run_in_background": false}'
    ),
    # the child runs a tool of its own, so the inline tree has something to draw
    # while the delegation is still in flight (pair with --live)
    "subagent_working": (
        'PROBE subagent {"description": "List the sources", "prompt": "PROBE bash'
        ' {\\"command\\": \\"sleep 4 && ls -1 src | head -3\\", \\"description\\": \\"peek at src\\"}",'
        ' "run_in_background": false}'
    ),
    # the harness's default: the call returns a durable id and the child runs on
    "subagent_background": (
        'PROBE subagent {"description": "Audit the tests", "prompt": "Summarise the test layout and stop."}'
    ),
    "workflow": (
        'PROBE workflow {"script": "log(\\"hello from the workflow\\")\\nreturn { ok: true }",'
        ' "meta": {"name": "gap-probe", "description": "a one-line workflow that returns immediately"}}'
    ),
    "skill": 'PROBE skill {"name": "nonexistent-skill"}',
    "read_image": 'PROBE read_image {"file_path": "e2e-scratch/gallery.png"}',
    # this one insists on an absolute path
    "str_replace_editor": ('PROBE str_replace_editor {"command": "view", "path": "%s/src/domain/usage.ts"}' % ROOT),
    "job_output": 'PROBE job_output {"job_id": "no-such-job"}',
    "send_message": 'PROBE send_message {"subagent_id": "no-such-agent", "message": "hello"}',
    "get_goal": 'PROBE get_goal {}',
    # plan mode has to be on before the tool will run; pair with --live to catch
    # the review prompt while it is up
    "exit_plan_mode": [
        '/plan',
        'PROBE exit_plan_mode {"plan": "# Close the tool-result gaps\\n\\n- read cards\\n- search cards"}'
    ],
    "job_list": 'PROBE job_list {}',
    "list_agents": 'PROBE list_agents {}',
    # a RUN of calls, which is the only way the collapsed brief reads right
    "mixed_run": (
        'PROBE read {"file_path": "src/domain/usage.ts"}'
        ' ;; PROBE read {"file_path": "src/domain/roles.ts"}'
        ' ;; PROBE glob {"pattern": "src/domain/*.ts"}'
        ' ;; PROBE bash {"command": "ls -1 src | head -3", "description": "peek"}'
        ' ;; PROBE bash {"command": "echo hi", "description": "echo"}'
    ),
    "todo": (
        'PROBE todo_write {"todos": [{"content": "first task", "status": "in_progress"},'
        ' {"content": "second task", "status": "pending"}]}'
    ),
}


def bootstrap() -> None:
    # the mutation scenarios must CREATE their file, not find yesterday's
    for leftover in (ROOT / "e2e-scratch").glob("gallery-*.txt"):
        leftover.unlink()
    PROFILE.mkdir(parents=True, exist_ok=True)
    (PROFILE / "package.json").write_text(
        json.dumps(
            {
                "name": "dsh-profile-gallery",
                "private": True,
                "dependencies": {},
                "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base"]}},
            },
            indent=2,
        )
    )
    spy = os.environ.get("GALLERY_SPY")
    SPY = f"    - id: spy\n      name: '{spy}'" if spy else ""
    PATCH.write_text(
        f"""# generated by scripts/tool-gallery.py
- id: hmr
  disabled: true
# `web_fetch` is off in dsh-base and its search provider wants a DeepSeek key;
# the gallery turns fetch on and points both at the probe plugin's canned
# providers, so the web cards render offline.
- id: tool-web
  config:
    fetch: true
    searchTimeoutMs: 60000
- id: web
  config:
    fetchProvider: probe
    searchProvider: probe
- insert:
    - id: probe-llm
      name: '{ROOT}/test/e2e/probe-llm.mjs'
{SPY}
    - id: cctui
      name: '{ROOT}/dist/plugin.js'
      config:
        provider: mock
        model: mock-1
        cwd: '{ROOT}'
"""
    )


class Session:
    """One dsh boot inside a PTY, with a minimal query-answering terminal."""

    def __init__(self) -> None:
        env = dict(os.environ)
        env["DSH_HOME"] = str(HOME)
        env["NODE_ENV"] = "production"
        env["DSH_CCTUI_INLINE"] = "1"
        env["DSH_CCTUI_HOME"] = str(HOME / "cctui")
        env.pop("DSH_CCTUI_THEME", None)
        cmd = [
            "node",
            str(ROOT / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"),
            "--profile",
            "gallery",
            "--patch",
            str(PATCH),
        ]
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        os.set_inheritable(slave, True)
        self.proc = subprocess.Popen(
            cmd, stdin=slave, stdout=slave, stderr=slave,
            env=env, cwd=str(ROOT), close_fds=True, preexec_fn=os.setsid,
        )
        os.close(slave)
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)

    def pump(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([self.master], [], [], 0.2)
            if self.master in ready:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                self.stream.feed(chunk)
                self._answer(chunk)
            if self.proc.poll() is not None:
                return

    def _answer(self, chunk: bytes) -> None:
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
            os.write(self.master, b"".join(replies))

    def display(self) -> str:
        return "\n".join(self.screen.display)

    def wait_for(self, needle: str, timeout: float) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if needle in self.display():
                return True
            if self.proc.poll() is not None:
                return False
        return needle in self.display()

    def wait_idle(self, timeout: float) -> bool:
        """The footer drops back to its idle hint when the turn is over."""
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.5)
            shown = self.display()
            if "? for shortcuts" in shown and "esc to interrupt" not in shown:
                return True
            if self.proc.poll() is not None:
                return False
        return False

    def send(self, data: bytes) -> None:
        os.write(self.master, data)

    def kill(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            os.close(self.master)
        except OSError:
            pass


def clean(text: str) -> str:
    lines = [line.rstrip() for line in text.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    # the first row can carry a stray echo of our own DA1/CPR answers
    if lines and len(lines[0].strip()) <= 3 and "\u2588" not in lines[0]:
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def capture(scenario: str, expand: bool, live: float | None = None) -> str | None:
    prompts = SCENARIOS[scenario]
    if isinstance(prompts, str):
        prompts = [prompts]

    session = Session()
    try:
        if not session.wait_for(PROMPT_GLYPH, 90):
            print(f"{scenario}: never reached the composer\n{session.display()}", file=sys.stderr)
            return None
        session.pump(1.5)
        for index, prompt in enumerate(prompts):
            session.send(prompt.encode())
            session.pump(0.8)
            session.send(b"\r")
            session.wait_for(TOOL_GLYPH, 60)
            if live is not None and index == len(prompts) - 1:
                session.pump(live)
                break
            session.wait_idle(90)
            session.pump(1.0)
        if expand:
            session.send(b"\x0f")  # ctrl+o
            session.pump(1.5)
        return clean(session.display())
    finally:
        session.kill()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="*", help=f"one or more of: {', '.join(SCENARIOS)}")
    ap.add_argument("--expand", action="store_true", help="press ctrl+o before capturing")
    ap.add_argument("--live", type=float, default=None, metavar="SECONDS",
                    help="capture this long after the first tool row instead of waiting for the turn to end")
    ap.add_argument("--out", default=str(HOME / "shots"))
    args = ap.parse_args()

    unknown = [name for name in args.scenarios if name not in SCENARIOS]
    if unknown:
        sys.exit(f"unknown scenario(s): {', '.join(unknown)}")

    if not (ROOT / "dist" / "plugin.js").exists():
        sys.exit("dist/plugin.js is missing — run `npm run build` first")

    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    bootstrap()

    for scenario in args.scenarios or list(SCENARIOS):
        shot = capture(scenario, args.expand, args.live)
        if shot is None:
            continue
        (outdir / f"{scenario}.txt").write_text(shot)
        print(f"=== {scenario} ===")
        print(shot)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
