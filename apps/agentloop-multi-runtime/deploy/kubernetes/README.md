# Multi-host Kubernetes deployment

This is the production deployment boundary for `agentloop-multi-runtime`:

- `router` is a two-replica Deployment using the `router` image target;
- `web` is a two-replica Deployment using the `web` image target;
- `runtime-host` is a StatefulSet using the `runtime-host` image target. Its
  stable Pod name is also its `RUNTIME_ID`, so every Router resolves the same
  concrete Host endpoint.

Build and publish the three roles independently from the repository root:

```bash
docker build --target router -f apps/agentloop-multi-runtime/Dockerfile -t REGISTRY/agentloop/router:VERSION .
docker build --target runtime-host -f apps/agentloop-multi-runtime/Dockerfile -t REGISTRY/agentloop/runtime-host:VERSION .
docker build --target web -f apps/agentloop-multi-runtime/Dockerfile -t REGISTRY/agentloop/web:VERSION .
```

Before applying the base, replace all `registry.example.invalid` image names,
the public URL in both `runtime-config.yaml` and `ingress.yaml`, and configure
an RWX storage class or pre-provision the three claims. Create the three
Secrets from the platform secret manager; `secret.example.yaml` must not be
applied. Copy `provider-config.example.yaml`, set the non-secret provider
configuration, and add the copied file to `kustomization.yaml`.

```bash
kubectl apply -k apps/agentloop-multi-runtime/deploy/kubernetes
```

The production invariant is explicit: Router and every Host use the same
PostgreSQL database; all Router replicas mount the same attachment filesystem;
all Host replicas mount the same workspace and Skill roots. SQLite and a
per-Pod attachment directory are rejected deployment choices, not production
fallbacks.

The two StatefulSet replicas are intentionally listed in `runtimes.json`.
Changing Host replica count requires adding/removing the matching stable
endpoint in that ConfigMap and rolling Router/Host together. This is an
explicit static-node contract, not hidden service discovery.

This deployment makes the three roles independently publishable and runnable
on distinct nodes. It does **not** claim automatic takeover of an in-flight
Run after a Host failure: that still requires the separately designed Run
lease, fencing, and receipt-aware recovery protocol.
