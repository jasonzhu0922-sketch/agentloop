#!/usr/bin/env python3
"""Host operations for the manual, SQLite-backed agentloop-mr deployment."""
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile


ROOT = Path(os.environ.get("AGENTLOOP_DEPLOY_ROOT", "/home/baoadmin/agentloop-mr")).resolve()
NETWORK = "agentloop-mr"
CONFIG = ROOT / "config/llm-providers.json"
PROVIDER_ENV = ROOT / "deploy/agentloop-multi-runtime/.env.providers"
SKILLS = ROOT / "custom-skills"


def command(*args, input_bytes=None, timeout=120):
    result = subprocess.run(args, input=input_bytes, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError("{} failed: {}".format(args[0], result.stderr.decode("utf8", "replace")[-400:]))
    return result.stdout


def docker_json(*args):
    return json.loads(command("docker", *args))


def current_runtimes():
    names = command("docker", "ps", "--format", "{{.Names}}").decode().splitlines()
    names = sorted(n for n in names if re.fullmatch(r"agentloop-mr-runtime-[0-9]{2}", n))
    if names != ["agentloop-mr-runtime-01", "agentloop-mr-runtime-02"]:
        raise RuntimeError("Expected both agentloop-mr Runtime containers to be running")
    specs = [docker_json("inspect", name)[0] for name in names]
    if len({s["Config"]["Image"] for s in specs}) != 1:
        raise RuntimeError("Runtime image selection differs")
    for spec in specs:
        if spec["HostConfig"]["NetworkMode"] != NETWORK or spec["HostConfig"]["Privileged"]:
            raise RuntimeError("Unexpected Runtime network or privilege configuration")
        if spec["HostConfig"]["PortBindings"]:
            raise RuntimeError("Runtime has unexpected published ports")
        mounts = {m["Destination"]: m["Source"] for m in spec["Mounts"]}
        if mounts.get("/run/config/llm-providers.json") != str(CONFIG):
            raise RuntimeError("Unexpected Runtime model config mount")
        if mounts.get("/app/apps/agentloop-multi-runtime/custom-skills") != str(SKILLS):
            raise RuntimeError("Unexpected Runtime Skill mount")
        env = dict(e.split("=", 1) for e in spec["Config"]["Env"] if "=" in e)
        if env.get("AGENTLOOP_STATE_DRIVER") != "sqlite":
            raise RuntimeError("This helper requires the SQLite-backed deployment")
    if not CONFIG.is_file() or not PROVIDER_ENV.is_file() or not SKILLS.is_dir():
        raise RuntimeError("Required deployment configuration is missing")
    return names, specs


def parse_env(text):
    values = {}
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError("Invalid Provider environment file")
        key, value = match.groups()
        if key in values or "\x00" in value:
            raise ValueError("Duplicate or invalid Provider variable")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = re.sub(r"\\(.)", r"\1", value[1:-1])
        values[key] = value
    return values


def env_bytes(values):
    for key, value in values.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or any(c in value for c in "\r\n\x00"):
            raise ValueError("Environment cannot be represented in a Docker env file")
    return "".join("{}={}\n".format(k, v) for k, v in values.items()).encode()


def candidate_envs(specs, provider, old_provider_keys, job):
    paths = []
    for index, spec in enumerate(specs):
        env = dict(e.split("=", 1) for e in spec["Config"]["Env"] if "=" in e)
        for key in old_provider_keys:
            env.pop(key, None)
        for key, value in provider.items():
            if key in env:
                raise ValueError("Provider env overlaps a deployment-owned variable")
            env[key] = value
        path = job / "runtime-{}.env".format(index)
        path.write_bytes(env_bytes(env))
        path.chmod(0o600)
        paths.append(path)
    return paths


def ensure_idle(name):
    script = ('import {DatabaseSync} from "node:sqlite";'
              'const db=new DatabaseSync(process.env.AGENTLOOP_STATE_SQLITE_PATH,{readOnly:true});'
              'console.log(db.prepare("SELECT count(*) AS n FROM runs WHERE status NOT IN '
              "('completed','failed','cancelled')"
              '").get().n);')
    count = int(command("docker", "exec", name, "node", "--input-type=module",
                        "-e", script).decode().strip())
    if count:
        raise RuntimeError("Active/nonterminal Runs: {}".format(count))


def validate_models(image, config_path, env_path):
    script = ('import {LlmProviderRegistry} from "@zhujun/agentloop";'
              'try{const p=await LlmProviderRegistry.fromConfigFile("/run/config/llm-providers.json");'
              'for(const key of p.modelKeys())p.create(key)}'
              'catch{console.error("Invalid model configuration or missing credential");process.exit(1)}')
    command("docker", "run", "--rm", "--network", NETWORK, "--env-file", str(env_path),
            "-v", "{}:/run/config/llm-providers.json:ro".format(config_path),
            "--entrypoint", "node", image, "--input-type=module", "-e", script, timeout=90)


def wait_ready(name):
    script = ('const port=process.env.PORT;'
              'for(let i=0;i<40;i++){try{const r=await fetch("http://127.0.0.1:"+port+"/healthz",'
              '{signal:AbortSignal.timeout(2000)});if(r.ok)process.exit(0)}catch{}'
              'await new Promise(r=>setTimeout(r,1000))}process.exit(1)')
    command("docker", "exec", name, "node", "-e", script, timeout=55)


def model_catalog(name):
    script = ('import {LlmProviderRegistry} from "@zhujun/agentloop";'
              'const p=await LlmProviderRegistry.fromConfigFile(process.env.LLM_PROVIDER_CONFIG_PATH);'
              'const expected=p.modelCatalog().map(x=>({key:x.key,displayName:x.displayName}))'
              '.sort((a,b)=>a.key.localeCompare(b.key));'
              'const r=await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/models");'
              'if(!r.ok)process.exit(1);'
              'const actual=(await r.json()).models.sort((a,b)=>a.key.localeCompare(b.key));'
              'if(JSON.stringify(actual)!==JSON.stringify(expected))process.exit(1);'
              'console.log(JSON.stringify(actual))')
    return json.loads(command("docker", "exec", name, "node", "--input-type=module", "-e", script))


def inventory(root):
    items = []
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or not (directory / "SKILL.md").is_file():
            continue
        files = sorted(p for p in directory.rglob("*") if p.is_file())
        digest = hashlib.sha256()
        total = 0
        for path in files:
            data = path.read_bytes()
            total += len(data)
            digest.update(path.relative_to(directory).as_posix().encode())
            digest.update(b"\x00")
            digest.update(data)
        description = next((line.split(":", 1)[1].strip()
                            for line in (directory / "SKILL.md").read_text(errors="replace").splitlines()
                            if line.startswith("description:")), "")
        items.append(dict(name=directory.name, description=description,
                          packageHash=digest.hexdigest(), fileCount=len(files),
                          totalBytes=total, hasEnvironment=(directory / ".env").is_file()))
    return items


def stage_skills(operation, job, image):
    stage = job / "skills-next"
    if operation == "skills-remove":
        name = (job / "skill-name").read_text()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", name) or not (SKILLS / name).is_dir():
            raise ValueError("Skill not found")
        shutil.copytree(str(SKILLS), str(stage), symlinks=True)
        shutil.rmtree(str(stage / name))
    else:
        archive = (job / "custom-skills.zip").read_bytes()
        normalized = command(
            "docker", "run", "--rm", "-i", "--entrypoint", "node",
            "-e", "SKILL_ARCHIVE_NAME=custom-skills.zip", image,
            "/app/apps/agentloop-multi-runtime/deploy/production/validate-skill-archive.mjs",
            input_bytes=archive, timeout=120,
        )
        with zipfile.ZipFile(io.BytesIO(normalized)) as package:
            for entry in package.infolist():
                if entry.is_dir():
                    continue
                parts = Path(entry.filename).parts
                if not parts or ".." in parts or entry.filename.startswith("/") or chr(92) in entry.filename:
                    raise ValueError("Invalid normalized Skill archive")
                target = stage.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(package.read(entry))
        for previous in SKILLS.rglob(".env"):
            target = stage / previous.relative_to(SKILLS)
            if target.parent.is_dir() and not target.exists():
                shutil.copy2(str(previous), str(target))
    if not stage.is_dir() or not inventory(stage):
        raise ValueError("Candidate Skill package is empty")
    owner = SKILLS.stat()
    for path in [stage] + list(stage.rglob("*")):
        if not path.is_symlink():
            os.chown(str(path), owner.st_uid, owner.st_gid)
    return stage


def replace_file(source, target):
    old = target.stat()
    staged = target.with_name(target.name + ".runtime-control-next")
    staged.write_bytes(Path(source).read_bytes())
    staged.chmod(old.st_mode & 0o777)
    os.chown(str(staged), old.st_uid, old.st_gid)
    os.replace(str(staged), str(target))


def create_runtime(name, spec, env_path):
    config = spec["Config"]
    args = ["docker", "create", "--name", name, "--network", NETWORK,
            "--restart", spec["HostConfig"]["RestartPolicy"]["Name"],
            "--env-file", str(env_path)]
    aliases = spec["NetworkSettings"]["Networks"][NETWORK].get("Aliases") or []
    for alias in aliases:
        if re.fullmatch(r"runtime-general-[0-9]{2}", alias):
            args.extend(["--network-alias", alias])
    for mount in spec["Mounts"]:
        if mount["Type"] != "bind":
            raise RuntimeError("Unexpected non-bind Runtime mount")
        args.extend(["-v", "{}:{}{}".format(mount["Source"], mount["Destination"],
                    "" if mount["RW"] else ":ro")])
    for key, value in (config.get("Labels") or {}).items():
        args.extend(["--label", "{}={}".format(key, value)])
    if config.get("User"):
        args.extend(["--user", config["User"]])
    if config.get("WorkingDir"):
        args.extend(["--workdir", config["WorkingDir"]])
    args.append(config["Image"])
    args.extend(config.get("Cmd") or [])
    command(*args)
    command("docker", "start", name)
    wait_ready(name)


def apply(operation, job, names, specs):
    image = specs[0]["Config"]["Image"]
    old_provider = parse_env(PROVIDER_ENV.read_text())
    provider = dict(old_provider)
    candidate_config = CONFIG
    candidate_provider = PROVIDER_ENV
    candidate_skills = None
    if operation == "llm":
        candidate_config = job / "llm-providers.json"
        config = json.loads(candidate_config.read_text())
        if not isinstance(config.get("providers"), dict) or not isinstance(config.get("models"), dict):
            raise ValueError("Invalid model configuration")
        if (job / "runtime.env").is_file():
            provider = parse_env((job / "runtime.env").read_text())
        if (job / "credential-updates.json").is_file():
            updates = json.loads((job / "credential-updates.json").read_text())
            allowed = {p.get("apiKeyEnv") for p in config["providers"].values() if isinstance(p, dict)}
            if any(key not in allowed for key in updates):
                raise ValueError("Credential update is not referenced by a Provider")
            provider.update(updates)
        candidate_provider = job / "providers-next.env"
        candidate_provider.write_bytes(env_bytes(provider))
        candidate_provider.chmod(0o600)
    if operation in ("skills", "skills-remove"):
        candidate_skills = stage_skills(operation, job, image)
    env_paths = candidate_envs(specs, provider, old_provider.keys(), job)
    for env_path in env_paths:
        validate_models(image, candidate_config, env_path)
    ensure_idle(names[0])

    backup = ROOT / "backups" / ("runtime-control-{}-{}".format(int(time.time()), os.getpid()))
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(str(CONFIG), str(backup / "llm-providers.json"))
    shutil.copy2(str(PROVIDER_ENV), str(backup / "providers.env"))
    if candidate_skills is not None:
        shutil.copytree(str(SKILLS), str(backup / "custom-skills"), symlinks=True)
    saved = {}
    try:
        if operation == "llm":
            replace_file(candidate_config, CONFIG)
            replace_file(candidate_provider, PROVIDER_ENV)
        if candidate_skills is not None:
            previous = backup / "custom-skills.original"
            SKILLS.rename(previous)
            candidate_skills.rename(SKILLS)
        for index, name in enumerate(names):
            ensure_idle(name)
            old_name = "{}.pre-control-{}".format(name, os.getpid())
            command("docker", "stop", name, timeout=40)
            command("docker", "rename", name, old_name)
            saved[name] = old_name
            create_runtime(name, specs[index], env_paths[index])
        expected = model_catalog(names[0])
        for name in names[1:]:
            if model_catalog(name) != expected:
                raise RuntimeError("Runtime model catalogs differ")
        (job / "applied-models.json").write_text(json.dumps(expected))
        if candidate_skills is not None:
            (job / "applied-skills.json").write_text(json.dumps(inventory(SKILLS)))
        print("Reloaded {} Runtime(s); backup: {}".format(len(names), backup))
    except Exception:
        replace_file(backup / "llm-providers.json", CONFIG)
        replace_file(backup / "providers.env", PROVIDER_ENV)
        if candidate_skills is not None and (backup / "custom-skills.original").exists():
            if SKILLS.exists():
                shutil.rmtree(str(SKILLS))
            (backup / "custom-skills.original").rename(SKILLS)
        for name in reversed(names):
            old_name = saved.get(name)
            if old_name:
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                command("docker", "rename", old_name, name)
                command("docker", "start", name)
                wait_ready(name)
            else:
                state = docker_json("inspect", name)[0]["State"]
                if not state["Running"]:
                    command("docker", "start", name)
        raise


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Host Runtime control must run as root")
    if len(sys.argv) != 3:
        raise ValueError("Expected operation and private job directory")
    operation, job_arg = sys.argv[1:]
    if operation not in ("preflight", "configuration", "skills-configuration", "reload", "llm", "skills", "skills-remove"):
        raise ValueError("Unsupported operation")
    job = Path(job_arg).resolve()
    if not job.is_dir() or not ROOT.is_dir():
        raise ValueError("Invalid deployment or job directory")
    with (ROOT / ".runtime-control.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        names, specs = current_runtimes()
        if operation == "configuration":
            print(CONFIG.read_text())
        elif operation == "skills-configuration":
            print(json.dumps(inventory(SKILLS), ensure_ascii=False))
        elif operation == "preflight":
            old_provider = parse_env(PROVIDER_ENV.read_text())
            paths = candidate_envs(specs, old_provider, old_provider.keys(), job)
            for path in paths:
                validate_models(specs[0]["Config"]["Image"], CONFIG, path)
            ensure_idle(names[0])
            for name in names:
                wait_ready(name)
                model_catalog(name)
            print("Single-host Runtime control preflight passed")
        else:
            apply(operation, job, names, specs)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
