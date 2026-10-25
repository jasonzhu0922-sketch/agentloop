#!/usr/bin/env python3
"""Host-owned Runtime and Skill operations. Web can request only allowlisted operations."""
import argparse
import base64
import binascii
import hmac
import json
import os
import re
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

    def configuration(self):
        with tempfile.TemporaryDirectory(prefix="agentloop-model-read-") as job:
            result = subprocess.run(["bash", self.helper, "configuration", job],
                                    env=dict(os.environ, AGENTLOOP_DEPLOY_ROOT=str(self.root)),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            if result.returncode:
                return 409, {"error": "configuration_read_failed"}
            try:
                return 200, {"configuration": json.loads(result.stdout)}
            except ValueError:
                return 500, {"error": "configuration_read_failed"}

    def skills_configuration(self):
        with tempfile.TemporaryDirectory(prefix="agentloop-skill-read-") as job:
            result = subprocess.run(["bash", self.helper, "skills-configuration", job],
                                    env=dict(os.environ, AGENTLOOP_DEPLOY_ROOT=str(self.root)),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            if result.returncode:
                return 409, {"error": "skill_configuration_read_failed"}
            try:
                return 200, {"skills": json.loads(result.stdout)}
            except ValueError:
                return 500, {"error": "skill_configuration_read_failed"}

    def start(self, payload=None):
        with self.lock:
            if self.state["status"] == "running":
                return 409, dict(self.state)
            operation = ("skills" if "archiveBase64" in payload else "skills-remove" if "skillName" in payload else "apply") if payload is not None else "reload"
            self.state = {"id": str(uuid.uuid4()), "operation": operation,
                          "status": "running", "phase": "validating", "startedAt": time.time()}
            self.update()
            threading.Thread(target=self.reload, args=(payload,), daemon=True).start()
            return 202, dict(self.state)

    def reload(self, payload=None):
        phase = "reload_failed"
        try:
            with tempfile.TemporaryDirectory(prefix="agentloop-runtime-reload-") as job:
                env = dict(os.environ, AGENTLOOP_DEPLOY_ROOT=str(self.root))
                operation = "reload"
                if payload is not None:
                    if "archiveBase64" in payload:
                        operation = "skills"
                        Path(job, "custom-skills.zip").write_bytes(base64.b64decode(payload["archiveBase64"], validate=True))
                    elif "skillName" in payload:
                        operation = "skills-remove"
                        Path(job, "skill-name").write_text(payload["skillName"])
                    else:
                        operation = "llm"
                        Path(job, "llm-providers.json").write_text(json.dumps(payload["configuration"]))
                        if "environment" in payload:
                            Path(job, "runtime.env").write_text(payload["environment"])
                        if payload.get("credentialUpdates"):
                            Path(job, "credential-updates.json").write_text(json.dumps(payload["credentialUpdates"]))
                process = subprocess.Popen(["bash", self.helper, operation, job], env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           universal_newlines=True)
                # Do not send shell output, file contents or credentials to Web.
                for line in process.stdout:
                    if "Active/nonterminal Runs:" in line:
                        phase = "active_runs"
                    elif any(message in line for message in ["Invalid model configuration or missing credential", "Invalid LLM schema", "Model cannot be configured:", "Invalid custom Skill archive", "Skill package validation failed", "BadZipFile"]):
                        phase = "invalid_configuration"
                    elif "Skill not found" in line:
                        phase = "skill_not_found"
                    elif "Another production operation holds the lock" in line:
                        phase = "operation_locked"
                    elif "Container readiness timed out" in line:
                        phase = "readiness_failed"
                    elif line.startswith("Ready:"):
                        with self.lock:
                            self.update(phase="checking_readiness")
                code = process.wait()
                models = json.loads(Path(job, "applied-models.json").read_text()) if code == 0 and Path(job, "applied-models.json").exists() else []
                skills = json.loads(Path(job, "applied-skills.json").read_text()) if code == 0 and Path(job, "applied-skills.json").exists() else []
                with self.lock:
                    self.update(status="succeeded" if code == 0 else "failed",
                                phase="complete" if code == 0 else phase, models=models, skills=skills, finishedAt=time.time())
        except Exception:
            with self.lock:
                self.update(status="failed", phase="reload_failed", finishedAt=time.time())


def serve(control, socket_path):
    class Handler(BaseHTTPRequestHandler):
        def handle_operation(self):
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + control.token).encode()):
                return self.reply(401, {"error": "operator_unauthorized"})
            if self.path not in ("/runtime-reload", "/model-configuration", "/skill-configuration"):
                return self.reply(404, {"error": "not_found"})
            if self.path == "/model-configuration":
                if self.command == "GET":
                    code, body = control.configuration()
                    return self.reply(code, body)
                if self.command == "POST":
                    try:
                        size = int(self.headers.get("Content-Length", "0"))
                        if self.headers.get("Transfer-Encoding") or not 0 < size <= 1024 * 1024:
                            raise ValueError()
                        payload = json.loads(self.rfile.read(size).decode("utf8"))
                        validate_payload(payload)
                    except (ValueError, TypeError, AttributeError):
                        return self.reply(400, {"error": "invalid_configuration_request"})
                    code, state = control.start(payload)
                    return self.reply(code, state)
                return self.reply(405, {"error": "method_not_allowed"})
            if self.path == "/skill-configuration":
                if self.command == "GET":
                    code, body = control.skills_configuration()
                    return self.reply(code, body)
                if self.command in ("POST", "DELETE"):
                    try:
                        size = int(self.headers.get("Content-Length", "0"))
                        max_size = 128 * 1024 * 1024 if self.command == "POST" else 4096
                        if self.headers.get("Transfer-Encoding") or not 0 < size <= max_size:
                            raise ValueError()
                        payload = json.loads(self.rfile.read(size).decode("utf8"))
                        validate_skill_payload(payload) if self.command == "POST" else validate_skill_remove_payload(payload)
                    except (ValueError, TypeError, AttributeError, binascii.Error):
                        return self.reply(400, {"error": "invalid_skill_configuration_request"})
                    code, state = control.start(payload)
                    return self.reply(code, state)
                return self.reply(405, {"error": "method_not_allowed"})
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


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) - {"configuration", "environment", "credentialUpdates"}:
        raise ValueError()
    config = payload.get("configuration")
    if not isinstance(config, dict) or not isinstance(config.get("providers"), dict) or not isinstance(config.get("models"), dict):
        raise ValueError()
    if "environment" in payload and not isinstance(payload["environment"], str):
        raise ValueError()
    updates = payload.get("credentialUpdates", {})
    if not isinstance(updates, dict):
        raise ValueError()
    admitted = {p.get("apiKeyEnv") for p in config["providers"].values() if isinstance(p, dict) and isinstance(p.get("apiKeyEnv"), str)}
    for key, value in updates.items():
        if key not in admitted or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key) or not isinstance(value, str) or not value or len(value) > 16384 or any(c in value for c in "\r\n\x00"):
            raise ValueError()


def validate_skill_payload(payload):
    if not isinstance(payload, dict) or set(payload) - {"archiveName", "archiveBase64"}:
        raise ValueError()
    name = payload.get("archiveName", "custom-skills.zip")
    encoded = payload.get("archiveBase64")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", name) or not name.lower().endswith(".zip"):
        raise ValueError()
    if not isinstance(encoded, str) or not encoded or len(encoded) > 120 * 1024 * 1024:
        raise ValueError()
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError()
    if not 1 <= len(decoded) <= 90 * 1024 * 1024 or not decoded.startswith(b"PK"):
        raise ValueError()


def validate_skill_remove_payload(payload):
    if not isinstance(payload, dict) or set(payload) != {"skillName"}:
        raise ValueError()
    name = payload.get("skillName")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name):
        raise ValueError()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/opt/agentloop")
    parser.add_argument("--socket", default="/run/agentloop-control/control.sock")
    parser.add_argument("--helper", required=True)
    parser.add_argument("--token-file", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    serve(RuntimeControl(args.root, args.helper, args.token_file), args.socket)
