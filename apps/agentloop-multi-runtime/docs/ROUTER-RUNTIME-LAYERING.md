# Router / Runtime layering

The multi-runtime deployment has three distinct execution boundaries:

```text
router-api -> router-service -> RuntimeControlPort
                              |-> HttpRuntimeControl -> Runtime Host API/Service
                              `-> LocalAgentRuntimeControl -> Local Agent WebSocket

Runtime Host Service / Local Agent Service -> RuntimeHostRunPort -> AgentLoop kernel
```

## Router

`router/api` owns browser and device HTTP transport. It authenticates requests,
decodes DTOs, and projects responses. It does not own scheduling state or
Runtime execution.

`router/service` owns Task and Assignment orchestration, Runtime selection,
dispatch idempotency, reconciliation, and Router-side Run projections. It
depends on `ControlPlaneRepository` and `RuntimeControlPort`, not SQL or the
AgentLoop kernel.

`router/runtime-control` adapts the transport-neutral Runtime control port to
both Cloud Runtime HTTP and Local Agent WebSocket connections. These are
outbound transport adapters, not Router API business logic.

## Runtime Host and Local Agent

`runtime-host/api` is a private Router-to-Host HTTP API. `runtime-host/service`
owns admission and Run projections, while `RuntimeHostRunPort` is the only
boundary into the AgentLoop kernel.

The Local Agent has the same split: `local-agent-runtime/src/api` exposes its
device-local HTTP API, `service` owns device and child-Runtime use cases, and
`connection` maintains the outbound Router control connection. The Local Agent
supervisor may own multiple child Runtimes, but Router sees each child through
the same `RuntimeControlPort` contract.

## Dependency rules

- API -> Service; API does not write persistence directly.
- Router Service -> control-plane ports and Runtime control ports.
- Runtime Host/Local Agent -> shared protocol contracts; neither imports Router
  application code.
- Runtime execution state remains Host/Local-Agent owned. Router stores only
  Assignment, liveness, and neutral Run projections.
- Local paths and credentials never cross the shared Router/Runtime protocol.

The process boundaries use only the explicit names `RouterService`,
`RuntimeHostService`, `LocalAgentRuntimeControl`, `HttpRuntimeControl`, and
`RuntimeControlPort`; no legacy class aliases are exported.
