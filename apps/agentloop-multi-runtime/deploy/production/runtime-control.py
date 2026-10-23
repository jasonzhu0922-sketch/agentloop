#!/usr/bin/env python3
"""Host-owned Runtime operations. Web can request only a fixed reload operation."""
import argparse
import hmac
import json
import os
import socketserver
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path


class RuntimeControl:
    def __init__(self, root, helper, token_file):
        self.root = Path(root)
        self.helper = str(Path(helper).resolve())
        self.token = Path(token_file).read_text().strip()
        if len(self.token) < 32:
            raise ValueError("Runtime control token must contain at least 32 characters")
        self.path = self.root / "control" / "runtime-reload.json"
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {"status": "idle"}
        if self.state["status"] == "running":
            self.update(status="failed", phase="reload_interrupted", finishedAt=time.time())

    def update(self, **fields):
        self.state.update(fields)
        staging = self.path.with_suffix(".tmp")
        staging.write_text(json.dumps(self.state))
        os.chmod(str(staging), 0o600)
        os.replace(str(staging), str(self.path))

    def start(self):
        with self.lock:
            if self.state["status"] == "running":
                return 409, dict(self.state)
            self.state = {"id": str(uuid.uuid4()), "status": "running", "phase": "validating", "startedAt": time.time()}
            self.update()
            threading.Thread(target=self.reload, daemon=True).start()
            return 202, dict(self.state)

    def reload(self):
        phase = "reload_failed"
        try:
            with tempfile.TemporaryDirectory(prefix="agentloop-runtime-reload-") as job:
                env = dict(os.environ, AGENTLOOP_DEPLOY_ROOT=str(self.root))
                process = subprocess.Popen(["bash", self.helper, "reload", job], env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           universal_newlines=True)
                # Do not send shell output, file contents or credentials to Web.
                for line in process.stdout:
                    if "Active/nonterminal Runs:" in line:
                        phase = "active_runs"
                    elif "Invalid model configuration or missing credential" in line:
                        phase = "invalid_configuration"
                    elif "Another production operation holds the lock" in line:
                        phase = "operation_locked"
                    elif "Container readiness timed out" in line:
                        phase = "readiness_failed"
                    elif line.startswith("Ready:"):
                        with self.lock:
                            self.update(phase="checking_readiness")
                code = process.wait()
                with self.lock:
                    self.update(status="succeeded" if code == 0 else "failed",
                                phase="complete" if code == 0 else phase, finishedAt=time.time())
        except Exception:
            with self.lock:
                self.update(status="failed", phase="reload_failed", finishedAt=time.time())


def serve(control, socket_path):
    class Handler(BaseHTTPRequestHandler):
        def handle_operation(self):
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + control.token).encode()):
                return self.reply(401, {"error": "operator_unauthorized"})
            if self.path != "/runtime-reload":
                return self.reply(404, {"error": "not_found"})
            if self.command == "GET":
                with control.lock:
                    return self.reply(200, dict(control.state))
            if self.command == "POST":
                # Fixed operation, no command/path/arguments accepted from Web.
                if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
                    return self.reply(400, {"error": "body_not_allowed"})
                code, state = control.start()
                return self.reply(code, state)
            return self.reply(405, {"error": "method_not_allowed"})

        do_GET = do_POST = do_DELETE = do_PUT = do_PATCH = handle_operation

        def reply(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            pass

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    path = Path(socket_path)
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    with Server(str(path), Handler) as server:
        os.chmod(str(path), 0o660)
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/opt/agentloop")
    parser.add_argument("--socket", default="/run/agentloop-control/control.sock")
    parser.add_argument("--helper", required=True)
    parser.add_argument("--token-file", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    serve(RuntimeControl(args.root, args.helper, args.token_file), args.socket)
