#!/usr/bin/env python3
"""Recreate only the existing MR Web container with the host control socket."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


NAME = "agentloop-mr-web"
SOCKET_DIR = "/run/agentloop-mr-control"
SOCKET = SOCKET_DIR + "/control.sock"


def docker(*args):
    result = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError("Docker command failed: {}".format(result.stderr.decode("utf8", "replace")[-300:]))
    return result.stdout


def main():
    if sys.argv[1:] not in (["--check"], ["--apply"]):
        raise ValueError("Usage: python3 attach-web-control.py --check|--apply")
    apply = sys.argv[1:] == ["--apply"]
    if not Path(SOCKET).is_socket():
        raise RuntimeError("Runtime control socket is not ready")
    spec = json.loads(docker("inspect", NAME))[0]
    if spec["HostConfig"]["NetworkMode"] != "agentloop-mr" or spec["HostConfig"]["Binds"]:
        raise RuntimeError("Unexpected Web network or mounts; inspect before replacing")
    ports = spec["HostConfig"]["PortBindings"]
    if ports != {"5174/tcp": [{"HostIp": "", "HostPort": "8083"}]}:
        raise RuntimeError("Unexpected Web port binding")
    env = dict(item.split("=", 1) for item in spec["Config"]["Env"] if "=" in item)
    if env.get("WEB_BASE_PATH") != "/agentloop" or env.get("ROUTER_URL") != "http://router:8788":
        raise RuntimeError("Unexpected Web runtime configuration")
    env["RUNTIME_CONTROL_SOCKET"] = SOCKET
    if any("\n" in value or "\r" in value for value in env.values()):
        raise RuntimeError("Web environment cannot be copied safely")
    if not apply:
        print("Web control-socket attachment preflight passed")
        return
    previous = NAME + ".pre-control"
    with tempfile.TemporaryDirectory(prefix="agentloop-web-control-") as staging:
        env_file = Path(staging) / "web.env"
        env_file.write_text("".join("{}={}\n".format(k, v) for k, v in env.items()))
        env_file.chmod(0o600)
        docker("stop", NAME)
        docker("rename", NAME, previous)
        try:
            args = ["run", "-d", "--name", NAME, "--network", "agentloop-mr",
                    "--network-alias", "web", "--restart", "unless-stopped",
                    "-p", "8083:5174", "-v", SOCKET_DIR + ":" + SOCKET_DIR + ":ro",
                    "--env-file", str(env_file)]
            for key, value in (spec["Config"].get("Labels") or {}).items():
                args.extend(["--label", "{}={}".format(key, value)])
            args.append(spec["Config"]["Image"])
            docker(*args)
            script = (
                'for(let i=0;i<30;i++){try{const r=await fetch("http://127.0.0.1:5174/api/operations/runtime-reload");'
                'if(r.status===401)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,1000))}process.exit(1)'
            )
            docker("exec", NAME, "node", "-e", script)
        except Exception:
            subprocess.run(["docker", "rm", "-f", NAME], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            docker("rename", previous, NAME)
            docker("start", NAME)
            raise
    print("Web connected to Runtime control; previous Web remains stopped as", previous)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
