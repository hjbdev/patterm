#!/usr/bin/env python3
"""Measure native CLI paste/Enter acceptance through a rejecting loopback API.

Requires Linux, Python 3, and the selected CLI on PATH. Runs the actual interactive
CLI in a PTY, with a fresh temporary home/configuration and dummy credentials.
No model executes. Startup and API-error recovery are outside measured intervals.
"""

import argparse
import fcntl
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import pty
import queue
import select
import shutil
import signal
import statistics
import struct
import subprocess
import tempfile
import termios
import threading
import time


class MockApi(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":[]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        messages = body.get("messages", body.get("input", []))
        users = [message for message in messages if isinstance(message, dict) and message.get("role") == "user"]
        content = users[-1].get("content", []) if users else []
        texts = [content] if isinstance(content, str) else [part["text"] for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)]
        self.server.requests.append({"time": time.monotonic(), "texts": texts, "tools": "tools" in body})
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"type":"error","error":{"type":"invalid_request_error","message":"PATTERM_ACCEPTED_NO_MODEL_EXECUTION"}}')


class Sidecar:
    def __init__(self, binary, env):
        self.process = subprocess.Popen([str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
        self.responses = queue.Queue()
        self.sequence = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        while header := self.process.stdout.read(4):
            length = int.from_bytes(header, "little")
            payload = self.process.stdout.read(length)
            if payload[0] == 1:
                self.responses.put(json.loads(payload[1:]))

    def request(self, method, params):
        self.sequence += 1
        self.process.stdin.write((json.dumps({"id": self.sequence, "method": "terminal.process." + method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        response = self.responses.get(timeout=5)
        if response["id"] != self.sequence or "error" in response:
            raise RuntimeError(response)
        return response["result"]


class Cli:
    def __init__(self, name, sidecar_binary=None):
        self.name = name
        self.root = Path(tempfile.mkdtemp(prefix=f"patterm-submit-{name}-"))
        self.api = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockApi)
        self.api.requests = []
        threading.Thread(target=self.api.serve_forever, daemon=True).start()
        endpoint = f"http://127.0.0.1:{self.api.server_port}"
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH")}
        # These are child-process environment values, not changes to the caller's
        # home, credentials, configuration, or existing CLI sessions.
        env.update({
            "HOME": str(self.root), "CODEX_HOME": str(self.root / "codex"),
            "CLAUDE_CONFIG_DIR": str(self.root / "claude"),
            "XDG_CONFIG_HOME": str(self.root / "config"), "XDG_DATA_HOME": str(self.root / "data"),
            "XDG_STATE_HOME": str(self.root / "state"), "XDG_CACHE_HOME": str(self.root / "cache"),
            "TERM": "xterm-256color", "COLORTERM": "truecolor",
            "OPENAI_API_KEY": "patterm-benchmark-not-a-key",
            "ANTHROPIC_API_KEY": "patterm-benchmark-not-a-key", "ANTHROPIC_BASE_URL": endpoint,
            "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_AUTOUPDATE": "true",
        })
        for directory in ("codex", "claude", "config", "data", "state", "cache"):
            (self.root / directory).mkdir()
        (self.root / "codex" / "config.toml").write_text(f'''model = "gpt-5.6-terra"
model_provider = "acceptance"
[model_providers.acceptance]
name = "acceptance"
base_url = "{endpoint}/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
[projects."{self.root}"]
trust_level = "trusted"
''')
        (self.root / "claude" / ".claude.json").write_text(json.dumps({
            "hasCompletedOnboarding": True, "theme": "dark",
            "projects": {str(self.root): {"hasTrustDialogAccepted": True}},
        }))
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
            "provider": {"openai": {"options": {"baseURL": endpoint + "/v1", "apiKey": "patterm-benchmark-not-a-key"}}},
            "model": "openai/gpt-5.4", "small_model": "openai/gpt-5.4",
            "enabled_providers": ["openai"], "autoupdate": False,
        })
        arguments = {
            "codex": ["--no-alt-screen", "-s", "read-only", "-a", "never"],
            "claude": ["--bare", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--model", "claude-sonnet-4-6"],
            "opencode": ["--pure"],
        }
        command = [shutil.which(name), *arguments[name]]
        if command[0] is None:
            raise RuntimeError(f"{name} is not installed")
        self.version = subprocess.check_output([command[0], "--version"], env=env, text=True, stderr=subprocess.DEVNULL).strip()
        self.sidecar = Sidecar(sidecar_binary, env) if sidecar_binary else None
        if self.sidecar:
            self.process_id = self.sidecar.request("spawn", {"command": command[0], "args": command[1:], "cwd": str(self.root), "kind": "agent", "cols": 120, "rows": 40})["process_id"]
        else:
            self.pid, self.fd = pty.fork()
            if self.pid == 0:
                os.chdir(self.root)
                os.execve(command[0], command, env)
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.set_blocking(self.fd, False)
        self.output = bytearray()
        self.drain(6)
        if name == "claude":
            self.write(b"\x1b[A\r")  # Approve the dummy key in this temporary profile.
            self.drain(2)
        self.output.clear()

    def drain(self, seconds):
        if self.sidecar:
            time.sleep(seconds)
            return
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if not select.select([self.fd], [], [], min(0.01, max(0, end - time.monotonic())))[0]:
                continue
            try:
                data = os.read(self.fd, 65536)
            except (BlockingIOError, OSError):
                return
            self.output.extend(data)
            for query, response in (
                (b"\x1b[6n", b"\x1b[1;1R"),
                (b"\x1b]11;?", b"\x1b]11;rgb:1515/1515/1515\x1b\\"),
                (b"\x1b]10;?", b"\x1b]10;rgb:fafa/fafa/fafa\x1b\\"),
            ):
                if query in data:
                    os.write(self.fd, response)

    def write(self, data):
        if self.sidecar:
            self.sidecar.request("input", {"process_id": self.process_id, "kind": "text", "text": data.decode(), "submit": False})
            return
        while data:
            try:
                written = os.write(self.fd, data)
                data = data[written:]
            except BlockingIOError:
                self.drain(0.005)

    def submit(self, prompt, delay_ms, kind="paste"):
        self.output.clear()
        start_index = len(self.api.requests)
        started = time.monotonic()
        if self.sidecar:
            self.sidecar.request("input", {"process_id": self.process_id, "kind": kind, "text": prompt, "submit": True})
            entered = None
        else:
            self.write(b"\x1b[200~" + prompt.encode() + b"\x1b[201~" if kind == "paste" else prompt.encode())
            self.drain(delay_ms / 1000)
            entered = time.monotonic()
            self.write(b"\r")
        control_reply_ms = (time.monotonic() - started) * 1000
        accepted = None
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            self.drain(0.01)
            accepted = next((request for request in self.api.requests[start_index:]
                             if any(text == prompt or (self.name == "opencode" and text == prompt + " ") for text in request["texts"])
                             and (self.name != "opencode" or request["tools"])), None)
            if accepted:
                break
        result = {
            "accepted": accepted is not None,
            "exact_text": prompt in accepted["texts"] if accepted else False,
            "native_trailing_space": bool(accepted and prompt not in accepted["texts"]),
            "latency_ms": (accepted["time"] - started) * 1000 if accepted else None,
            "after_enter_ms": (accepted["time"] - entered) * 1000 if accepted and entered is not None else None,
            "control_reply_ms": control_reply_ms if self.sidecar else None,
            "prompt_bytes": len(prompt.encode()), "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        }
        if not accepted:
            # A second Enter diagnoses a swallowed submission but does not count
            # as success for the measured first Enter.
            self.write(b"\r")
            self.drain(0.5)
            result["accepted_after_second_enter"] = any(prompt in request["texts"] for request in self.api.requests[start_index:])
            (self.root / f"failure-{result['prompt_sha256'][:12]}.bin").write_bytes(self.output)
        self.drain(0.25)
        return result

    def close(self):
        if self.sidecar:
            self.sidecar.request("close", {"process_id": self.process_id})
            self.sidecar.process.terminate()
            self.sidecar.process.wait(timeout=5)
            self.api.shutdown()
            self.api.server_close()
            return
        try:
            os.killpg(self.pid, signal.SIGTERM)
            for _ in range(20):
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.05)
            else:
                os.killpg(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        except ProcessLookupError:
            pass
        os.close(self.fd)
        self.api.shutdown()
        self.api.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", choices=["codex", "claude", "opencode"], action="append")
    parser.add_argument("--samples", type=int, default=10)
    parser.add_argument("--kind", choices=["paste", "text"], default="paste")
    parser.add_argument("--workload", choices=["short", "multiline", "large"], action="append")
    parser.add_argument("--sidecar", type=lambda value: Path(value).resolve())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = []
    for name in args.cli or ["codex", "claude", "opencode"]:
        cli = Cli(name, args.sidecar)
        try:
            warmup = cli.submit("PATTERM_WARMUP: reply with OK only. Do not use tools.", 100)
            if not warmup["accepted"]:
                raise RuntimeError(f"{name} failed the readiness probe. Evidence: {cli.root}")
            for workload in args.workload or ("short", "multiline", "large"):
                measurements = {None: []} if args.sidecar else {0: [], 100: []}
                for index in range(args.samples):
                    for delay in list(measurements) if index % 2 == 0 else list(reversed(measurements)):
                        marker = f"PATTERM_{name}_{workload}_{index:02d}_{delay}"
                        prompt = marker + ": reply with OK only. Do not use tools."
                        if workload == "multiline":
                            prompt += "\nsecond line: é中🦀\nthird line: preserve input order."
                        elif workload == "large":
                            prompt += "\n" + ("0123456789abcdef" * 1024) + "\nEND_" + marker
                        measurements[delay].append(cli.submit(prompt, delay, args.kind))
                for delay, samples in measurements.items():
                    times = sorted(sample["latency_ms"] for sample in samples if sample["accepted"])
                    result = {"cli": name, "version": cli.version, "transport": str(args.sidecar) if args.sidecar else "direct PTY", "kind": args.kind, "workload": workload, "delay_ms": delay,
                              "correct": len(times), "samples": args.samples,
                              "exact_text": sum(sample["exact_text"] for sample in samples),
                              "median_ms": statistics.median(times) if times else None,
                              "p95_ms": times[math.ceil(len(times) * 0.95) - 1] if times else None,
                              "raw": samples, "evidence_directory": str(cli.root)}
                    results.append(result)
                    print(json.dumps({key: value for key, value in result.items() if key != "raw"}), flush=True)
                args.output.write_text(json.dumps({
                    "boundary": "Native CLI input submission to matching prompt in the loopback API request; no inference; sequential submissions with 250ms error recovery between samples",
                    "acceptance_policy": "Full prompt equals an API user text block. OpenCode adds one trailing space to expanded pastes; that counts as accepted but not exact_text.",
                    "results": results,
                }, indent=2) + "\n")
        finally:
            cli.close()


if __name__ == "__main__":
    main()
