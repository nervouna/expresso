#!/usr/bin/env python3
"""Exercise the real Pi CLI in a PTY without model requests or personal settings."""
import fcntl
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run(mode):
    fixture = json.loads(subprocess.check_output(
        ["node", "--import", "tsx", "scripts/demo.ts", "--prepare-only", "--tui-mode", mode],
        cwd=ROOT, text=True,
    ))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 100, 120, 960, 1600))
    protocol = "kitty" if mode == "fullscreen" else "iterm2"
    image_markers = (b"\x1b_Ga=T", b"\x1b_Ga=p") if mode == "fullscreen" else (b"\x1b]1337;File=",)
    env = {**os.environ, "PI_CODING_AGENT_DIR": fixture["agentDir"],
           "PI_TELEMETRY": "0", "PI_IMAGE_PROTOCOL": protocol, "TERM": "xterm-256color"}
    process = subprocess.Popen([fixture["command"], *fixture["args"]], cwd=ROOT,
                               env=env, stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    os.close(slave)
    transcript = bytearray()

    def drain(timeout=8, marker=None):
        data = bytearray()
        deadline = time.monotonic() + timeout
        quiet_since = time.monotonic()
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    block = os.read(master, 65536)
                except OSError:
                    break
                if not block:
                    break
                data.extend(block)
                transcript.extend(block)
                quiet_since = time.monotonic()
                if b"\x1b[6n" in block:
                    os.write(master, b"\x1b[1;1R")
            elif time.monotonic() - quiet_since > 0.8 and (marker is None or marker in data):
                break
        assert process.poll() is None, f"Pi exited early: {process.returncode}"
        if marker is not None:
            assert marker in data, f"Missing terminal output: {marker!r}"
        return bytes(data)

    try:
        collapsed = drain(marker=b"Used 3 tools")
        assert b"EXPRESSO_DETAIL_" not in collapsed, "Collapsed output leaked tool results"
        assert b"EXPRESSO_COMMAND_BODY" not in collapsed, "Collapsed output leaked arguments"
        assert b"failed" in collapsed, "Failure marker is missing"
        assert any(marker in collapsed for marker in image_markers), "Inline image is missing"
        os.write(master, b"\x0f")
        expanded = drain(marker=b"EXPRESSO_DETAIL_right2")
        assert any(marker in expanded for marker in image_markers), "Expansion removed the image"
        os.write(master, b"\x0f")
        collapsed_again = drain(marker=b"Used 3 tools")
        assert b"EXPRESSO_DETAIL_" not in collapsed_again
        os.write(master, b"/reload\r")
        reloaded = drain(marker=b"Used 3 tools")
        assert b"EXPRESSO_DETAIL_" not in reloaded
        for columns in (32, 120):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 100, columns, columns * 8, 1600))
            os.kill(process.pid, signal.SIGWINCH)
            drain(timeout=3)
        assert b"Extension Error" not in transcript
        assert b"Failed to load extension" not in transcript
        print(f"PASS {mode}: collapsed, Ctrl+O, images, reload, resize")
    except Exception:
        with tempfile.NamedTemporaryFile(prefix=f"pi-expresso-{mode}-", suffix=".ansi", delete=False) as log:
            log.write(transcript)
            print(f"Terminal log: {log.name}")
        raise
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
        shutil.rmtree(fixture["directory"], ignore_errors=True)


for tui_mode in ("fullscreen", "regular"):
    run(tui_mode)
