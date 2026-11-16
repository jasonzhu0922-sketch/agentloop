#!/usr/bin/env python3
"""One-time, account-only production cutover on the existing PostgreSQL host.

Run from a reviewed release directory after building its Account Service image.
No credentials leave the server. Other containers and business databases stay live.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time
from urllib.parse import quote
import uuid


def run(args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # SQL, connection strings, and authentication envelopes must not be logged.
        raise RuntimeError("command failed: " + " ".join(args[:3]))
    return result.stdout.decode()


def pg(sql, database="postgres"):
    return run(["sudo", "-u", "postgres", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", database], sql.encode()).strip()


def save(path, content):
    with open(str(path), "x") as stream:
        os.chmod(str(path), 0o600)
        stream.write(content)


def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def account_block(content):
    start = content.index("  account-service:\n")
    end = content.index("  router:\n", start)
    return content[start:end]


def replace_account(content, block):
    start = content.index("  account-service:\n")
    end = content.index("  router:\n", start)
    return content[:start] + block + content[end:]


def snapshot(source, target, image):
    # CentOS Python 3.6 has no SQLite backup API. Use the pinned Node runtime,
    # opening the source read-only and retaining every committed WAL record.
    # The source mount permits SQLite's shared-memory bookkeeping, not SQL writes.
    script = """import {DatabaseSync,backup} from 'node:sqlite';
const original=new DatabaseSync('/source/accounts.db',{readOnly:true});
try{await backup(original,'/snapshots/'+process.argv[1]);}finally{original.close();}
const frozen=new DatabaseSync('/snapshots/'+process.argv[1]);
try{frozen.exec('PRAGMA journal_mode=DELETE');}finally{frozen.close();}"""
    run(["docker", "run", "--rm", "--network", "none", "--mount", "type=bind,src=%s,dst=/source" % source.parent,
         "--mount", "type=bind,src=%s,dst=/snapshots" % target.parent, image, "node", "--input-type=module", "-e", script, target.name])
    os.chmod(str(target), 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--base-image-id", required=True)
    args = parser.parse_args()
    assert os.getuid() == 0
    root = Path("/opt/agentloop")
    release = Path(args.release_dir).resolve()
    assert release.parent == root / "releases"
    lock = open(str(root / ".production-release.lock"), "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    account_name = "agentloop-account-service-1"
    current = inspect(account_name)
    assert current["Image"] == args.base_image_id, "serving account image changed"
    old_env = dict(item.split("=", 1) for item in current["Config"]["Env"] if "=" in item)
    assert old_env.get("ACCOUNT_SERVICE_DATABASE_DRIVER", "sqlite") == "sqlite"
    old_compose = Path(current["Config"]["Labels"]["com.docker.compose.project.config_files"])
    source = next(Path(m["Source"]) / "accounts.db" for m in current["Mounts"] if m["Destination"] == "/var/lib/agentloop-account")
    assert source.is_file()
    deployment = root / "deployments" / release.name
    deployment.mkdir(mode=0o700, exist_ok=True)
    backup = release / "backup"
    backup.mkdir(mode=0o700, exist_ok=True)
    assert not (release / "database.env").exists(), "preparation already provisioned; inspect its state"
    if (backup / "deployment.env").exists():
        assert (backup / "deployment.env").read_bytes() == (root / ".env").read_bytes(), "deployment changed after prior preparation"
    shutil.copy2(str(root / ".env"), str(backup / "deployment.env"))
    shutil.copy2(str(old_compose), str(backup / "compose.yaml"))
    snapshot(source, backup / "accounts-before.db", args.image)
    old_metadata = json.loads((old_compose.parent / "topology.json").read_text())
    old_template = Path(old_metadata["templateDirectory"])
    templates = release / "deploy" / "centos7"
    shutil.copytree(str(old_template), str(templates))
    block = account_block((release / "production-account-template.yaml").read_text())
    (templates / "compose.yaml").write_text(replace_account((templates / "compose.yaml").read_text(), block))
    for parent in old_template.parents:
        manifest = parent / "release-manifest.env"
        if manifest.is_file():
            shutil.copy2(str(manifest), str(release / "release-manifest.env"))
            break
    candidate = deployment / "compose.yaml"
    candidate.write_text(replace_account(old_compose.read_text(), block))
    os.chmod(str(candidate), 0o600)
    old_metadata["templateDirectory"] = str(templates)
    save(deployment / "topology.json", json.dumps(old_metadata))
    db_name = "agentloop_accounts"
    role = "agentloop_accounts"
    assert pg("SELECT count(*) FROM pg_database WHERE datname='agentloop_accounts'") == "0", "destination must be new"
    assert pg("SELECT count(*) FROM pg_roles WHERE rolname='agentloop_accounts'") == "0", "role must be new"
    password = secrets.token_urlsafe(36)
    pg("CREATE ROLE agentloop_accounts LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT" % password)
    run(["sudo", "-u", "postgres", "createdb", "--owner", role, db_name])
    pg("REVOKE ALL ON DATABASE agentloop_accounts FROM PUBLIC; GRANT CONNECT ON DATABASE agentloop_accounts TO agentloop_accounts")
    pg("ALTER SCHEMA public OWNER TO agentloop_accounts; REVOKE CREATE ON SCHEMA public FROM PUBLIC", db_name)
    hba = Path(pg("SHOW hba_file"))
    shutil.copy2(str(hba), str(backup / "pg_hba.conf"))
    network = json.loads(run(["docker", "network", "inspect", "agentloop_default"]))[0]
    subnets = [item["Subnet"] for item in network["IPAM"]["Config"]]
    with hba.open("a") as stream:
        for subnet in subnets:
            stream.write("\nhost agentloop_accounts agentloop_accounts %s scram-sha-256 # AgentLoop Account Service\n" % subnet)
    assert pg("SELECT pg_reload_conf()") == "t"
    database_url = "postgresql://%s:%s@host.docker.internal:5432/%s" % (role, quote(password, safe=""), db_name)
    database_env = release / "database.env"
    save(database_env, "ACCOUNT_SERVICE_DATABASE_DRIVER=postgres\nACCOUNT_SERVICE_DATABASE_URL=" + database_url + "\nACCOUNT_SERVICE_DATABASE_POOL_SIZE=5\n")
    desired = {"ACCOUNT_SERVICE_DATABASE_URL": database_url, "ACCOUNT_SERVICE_DATABASE_POOL_SIZE": "5", "ACCOUNT_SERVICE_IMAGE": args.image}
    lines = (root / ".env").read_text().splitlines()
    lines = [line for line in lines if line.split("=", 1)[0] not in desired]
    candidate_env = release / "candidate.env"
    save(candidate_env, "\n".join(lines + [key + "=" + value for key, value in desired.items()]) + "\n")

    def compose(path, env):
        return ["docker", "compose", "--project-directory", str(root), "--env-file", str(env), "-f", str(path)]

    before_config = json.loads(run(compose(old_compose, root / ".env") + ["config", "--format", "json"]))
    after_config = json.loads(run(compose(candidate, candidate_env) + ["config", "--format", "json"]))
    assert set(before_config["services"]) == set(after_config["services"])
    untouched = {}
    for name, settings in before_config["services"].items():
        if name != "account-service":
            assert settings == after_config["services"][name], "unrelated service configuration changed"
            container = "agentloop-" + name + "-1"
            untouched[container] = inspect(container)["Id"]
    base_run = ["docker", "run", "--rm", "--network", "agentloop_default", "--add-host", "host.docker.internal:host-gateway", "--env-file", str(database_env)]
    run(base_run + [args.image, "node", "--input-type=module", "-e", "import {openAccountDatabase} from './src/database.ts';const db=await openAccountDatabase();try{await db.prepare('SELECT 1').get();}finally{await db.close();}"])
    print("PREPARED: isolated PostgreSQL database and role; other service configurations unchanged", flush=True)

    def auth(path, body=None, token=None):
        # Run through the same Router auth forwarding path as production Desktop.
        js = """import {readFileSync} from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const r=await fetch('http://127.0.0.1:8788/v1/auth/'+input.path,{method:input.path==='me'?'GET':'POST',headers:{'Content-Type':'application/json',...(input.token?{Authorization:'Bearer '+input.token}:{})},...(input.body?{body:JSON.stringify(input.body)}:{})});
const body=r.status===204?{}:await r.json();console.log(JSON.stringify({status:r.status,body}));"""
        output = run(["docker", "exec", "-i", "agentloop-router-1", "node", "--input-type=module", "-e", js], json.dumps({"path": path, "body": body, "token": token}).encode())
        return json.loads(output)

    credentials = {"email": "pg-cutover-" + uuid.uuid4().hex + "@account-migration.invalid", "password": secrets.token_urlsafe(30)}
    probe = auth("register", credentials)
    assert probe["status"] == 201
    old_token = probe["body"]["token"]
    principal = {"user": probe["body"]["user"], "tenant": probe["body"]["tenant"]}
    assert auth("me", token=old_token)["status"] == 200
    switched = False
    try:
        run(["docker", "stop", "--time", "30", account_name])
        assert not inspect(account_name)["State"]["Running"]
        frozen = backup / "accounts-frozen.db"
        snapshot(source, frozen, args.image)
        migrate_run = base_run + ["--mount", "type=bind,src=%s,dst=/migration,readonly" % backup, args.image, "node", "src/migrate-sqlite-postgres.ts", "--source", "/migration/accounts-frozen.db"]
        migration = json.loads(run(migrate_run))
        assert migration["verified"]
        assert json.loads(run(migrate_run + ["--verify-only"])) == migration
        save(release / "migration-verification.json", json.dumps(migration))
        print("MIGRATED: all identity values and hashes verified in one transaction", flush=True)
        shutil.copy2(str(candidate_env), str(root / ".env"))
        # Once activation begins, a new PG writer may exist even if Compose
        # returns an error. Never restore the retired SQLite authority then.
        switched = True
        run(compose(candidate, root / ".env") + ["up", "-d", "--no-deps", "--no-build", "--force-recreate", "account-service"])

        def ready():
            for attempt in range(60):
                if inspect(account_name)["State"].get("Health", {}).get("Status") == "healthy":
                    return
                time.sleep(0.5)
            raise RuntimeError("account service readiness failed")

        ready()
        me = auth("me", token=old_token)
        assert me["status"] == 200
        assert {"user": me["body"]["user"], "tenant": me["body"]["tenant"]} == principal
        login = auth("login", credentials)
        assert login["status"] == 200
        assert {"user": login["body"]["user"], "tenant": login["body"]["tenant"]} == principal
        assert auth("register", credentials)["status"] == 409
        run(compose(candidate, root / ".env") + ["restart", "account-service"])
        ready()
        assert auth("me", token=old_token)["status"] == 200
        assert auth("me", token=login["body"]["token"])["status"] == 200
        assert auth("logout", token=old_token)["status"] == 204
        assert auth("me", token=old_token)["status"] == 401
        cleanup = """import {readFileSync} from 'node:fs';import {openAccountDatabase} from './src/database.ts';
const p=JSON.parse(readFileSync(0,'utf8'));const db=await openAccountDatabase();
try{await db.transaction(async()=>{const user=await db.prepare('SELECT email FROM mr_identity_users WHERE id=?').get(p.userId);if(user?.email!==p.email)throw Error('probe_identity_mismatch');await db.prepare('DELETE FROM mr_identity_tenants WHERE id=?').run(p.tenantId);await db.prepare('DELETE FROM mr_identity_users WHERE id=?').run(p.userId);});}finally{await db.close();}"""
        run(["docker", "exec", "-i", "-w", "/app/apps/agentloop-account-service", account_name, "node", "--input-type=module", "-e", cleanup], json.dumps({"userId": principal["user"]["id"], "tenantId": principal["tenant"]["id"], "email": credentials["email"]}).encode())
        for container, container_id in untouched.items():
            assert inspect(container)["Id"] == container_id, "unrelated container was recreated"
        final_counts = json.loads(pg("SELECT json_build_object('users',(SELECT count(*) FROM mr_identity_users),'tenants',(SELECT count(*) FROM mr_identity_tenants),'memberships',(SELECT count(*) FROM mr_identity_memberships),'sessions',(SELECT count(*) FROM mr_identity_sessions))", db_name))
        pg_dump = subprocess.check_output(["sudo", "-u", "postgres", "pg_dump", "-Fc", db_name])
        (backup / "accounts-postgres.dump").write_bytes(pg_dump)
        os.chmod(str(backup / "accounts-postgres.dump"), 0o600)
        report = {"storage": "postgres", "database": db_name, "role": role, "image": args.image, "counts": final_counts,
                  "preCutoverTokenSurvived": True, "passwordLoginVerified": True, "duplicateEmailStatus": 409,
                  "restartSessionsVerified": True, "logoutVerified": True, "probeAccountRemoved": True,
                  "otherContainersUnchanged": True, "sourceSnapshot": str(frozen)}
        save(release / "cutover-verification.json", json.dumps(report))
        (release / "DEPLOY_SUCCEEDED").touch()
        print(json.dumps(report), flush=True)
    except Exception:
        if not switched:
            shutil.copy2(str(backup / "deployment.env"), str(root / ".env"))
            run(["docker", "start", account_name])
            print("CUTOVER ABORTED BEFORE PG ACTIVATION: original service restored", flush=True)
        else:
            print("POST-ACTIVATION CHECK FAILED: PostgreSQL retained as authority; do not restore stale SQLite", flush=True)
        raise


if __name__ == "__main__":
    main()
