#!/usr/bin/env python3
"""Exercise the real Pi CLI in a PTY with offline fixtures and isolated settings."""
import fcntl
import json
import os
import pty
import re
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


def run(mode, nerd_fonts, live=False, response_timing=False):
    fixture = json.loads(subprocess.check_output(
        ["node", "--import", "tsx", "scripts/demo.ts", "--prepare-only", "--tui-mode", mode,
         *(["--nerd-fonts"] if nerd_fonts else []), *(["--live"] if live else []),
         *(["--response-timing"] if response_timing else [])],
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

    def assert_style(data, enabled):
        assert b"took 48s" in data, "Saved duration is missing"
        if enabled:
            assert " Used 3 tools".encode() in data, "Successful-group icon is missing"
            assert " Used 2 tools ( 1)".encode() in data, "Failed-group icons are missing"
            assert " edit".encode() in data, "Standalone completion icon is missing"
        else:
            assert b"[1 failed] Used 2 tools" in data, "Failure text is missing"
            assert b"[done] edit" in data, "Standalone completion text is missing"

    try:
        collapsed = drain(marker=b"Used 3 tools")
        assert b"EXPRESSO_DETAIL_" not in collapsed, "Collapsed output leaked tool results"
        assert b"EXPRESSO_COMMAND_BODY" not in collapsed, "Collapsed output leaked arguments"
        assert_style(collapsed, nerd_fonts)
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
        assert_style(reloaded, nerd_fonts)
        settings_path = Path(fixture["agentDir"]) / "settings.json"
        settings = json.loads(settings_path.read_text())
        settings["expresso"]["nerdFonts"] = not nerd_fonts
        settings["expresso"]["footer"] = True
        settings_path.write_text(json.dumps(settings))
        os.write(master, b"/reload\r")
        changed = drain(marker=b"Used 3 tools")
        assert_style(changed, not nerd_fonts)
        def has_progress(data):
            plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", data.decode("utf-8", errors="replace"))
            return re.search(r"[━─\uee00-\uee05]{10} (?:\?|\d+(?:\.\d+)?)%", plain) is not None

        assert has_progress(changed), "Full footer progress bar is missing"
        assert b"EXPRESSO_DETAIL_" not in changed
        for columns in (32, 120):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 100, columns, columns * 8, 1600))
            os.kill(process.pid, signal.SIGWINCH)
            resized = drain(timeout=3)
            if columns == 120:
                assert has_progress(resized), "Resize did not restore the full footer"
            if columns == 32:
                assert not has_progress(resized), "Compact footer still shows the progress bar"
                plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", resized)
                assert re.search(rb"edit [^\r\n]*, took 48s", plain), "Long standalone path hid the timer"
        settings["expresso"]["footer"] = False
        settings_path.write_text(json.dumps(settings))
        os.write(master, b"/reload\r")
        restored = drain(marker=b"Used 3 tools")
        assert not has_progress(restored), "Disabling the footer did not restore vanilla Pi"
        if live:
            settings["expresso"]["nerdFonts"] = nerd_fonts
            settings_path.write_text(json.dumps(settings))
            os.write(master, b"/reload\r")
            assert_style(drain(marker=b"Used 3 tools"), nerd_fonts)
            os.write(master, b"Run the offline timer demo.\r")
            running = drain(timeout=25, marker=b"LIVE TIMER COMPLETE")
            plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", running)
            assert b"Using 2 tools" in plain
            assert len(set(re.findall(rb"(\d+)s elapsed", plain))) >= (3 if response_timing else 2), \
                "Live duration did not advance"
            after_tools = plain[plain.index(b"Tools finished;"):]
            if response_timing:
                assert len(set(re.findall(rb"Used 2 tools[^\r\n]*?, (\d+)s elapsed", after_tools))) >= 2, \
                    "Timer stopped before the final answer finished"
            else:
                assert not re.search(rb"Used 2 tools[^\r\n]*?elapsed", after_tools), \
                    "Completed groups kept ticking during the final answer"
            assert b"EXPRESSO_LIVE_DETAIL" not in running

            def records():
                entries = [json.loads(line) for line in Path(fixture["sessionFile"]).read_text().splitlines()]
                return [entry["data"] for entry in entries if entry.get("customType") == "expresso:round-timing"
                        and all(tool_id.startswith("live-") for tool_id in entry["data"]["toolCallIds"])]

            saved = records()
            assert len(saved) == 1 and len(saved[0]["toolCallIds"]) == 4, "Groups did not share one round"
            duration = saved[0]['elapsedMs'] if response_timing else max(
                tool['endedMs'] for tool in saved[0]['tools'][:2]) - min(
                tool['startedMs'] for tool in saved[0]['tools'][:2])
            final_label = f"took {int(duration // 1000)}s".encode()
            assert final_label in running, "Final duration was not rendered"
            os.write(master, b"\x0f")
            drain(marker=b"EXPRESSO_LIVE_DETAIL")
            os.write(master, b"\x0f")
            drain(marker=final_label)
            os.write(master, b"/reload\r")
            drain(marker=final_label)
            assert records() == saved, "Reload changed the frozen duration"

            os.write(master, b"Run the offline timer demo again.\r")
            drain(timeout=1.2, marker=b"Using 2 tools")
            os.write(master, b"\x1b")
            drain(timeout=8, marker=b"took ")
            stopped = records()
            assert len(stopped) == 2, "Abort did not freeze the new round"
            assert stopped[0] == saved[0], "A later round changed an earlier duration"
            assert stopped[1]["elapsedMs"] < saved[0]["elapsedMs"], "Abort kept the timer running"
        assert b"Extension Error" not in transcript
        assert b"Failed to load extension" not in transcript
        checks = "live ticks, final duration, abort, reload" if live else "collapsed, Ctrl+O, images, reload, settings toggle, resize"
        print(f"PASS {mode}, nerdFonts={nerd_fonts}, responseTiming={response_timing}: {checks}")
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


if __name__ == "__main__":
    for tui_mode in ("fullscreen", "regular"):
        for use_nerd_fonts in (False, True):
            run(tui_mode, use_nerd_fonts)
        run(tui_mode, tui_mode == "fullscreen", live=True)
        run(tui_mode, tui_mode == "fullscreen", live=True, response_timing=True)
