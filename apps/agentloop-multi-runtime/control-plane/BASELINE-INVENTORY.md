# WP-0 baseline inventory

This is a path-and-consumer inventory, not a configuration import. No `.env` file, secret value, local deployment configuration, or Kubernetes Secret was read. The hashes below cover only tracked, credential-free JSON templates/configuration files; deployment-owned values remain deliberately uninspected.

| Baseline source | SHA-256 | Current consumers | Intended future target |
| --- | --- | --- | --- |
| `config/llm-providers.example.json` | `66f252ec09ed16efb4fd5a53a623da726ed54e0fe7396e87384651c63e08c59d` | Cloud Runtime bootstrap/package examples | Cloud Integration/Model Route baseline release |
| `local-agent-runtime/config/llm-providers.example.json` | `66f252ec09ed16efb4fd5a53a623da726ed54e0fe7396e87384651c63e08c59d` | Local Agent bootstrap/package examples | Local Integration/Model Route baseline release |
| `config/skill-directories.json` and `local-agent-runtime/config/skill-directories.json` | `cb367ae3a0a18f48c4ffe035520b726491594e006996e87384651c63e08c59c` | Explicit file-mode/bootstrap loader only | Cloud/Local Skill assignment baseline |
| `config/step-execution-strategy.json` and `local-agent-runtime/config/step-execution-strategy.json` | `39af8e7470267e2ed3d9a8cfad6dcd3eb6d2d0d0f2b91a9965a14be475016862` | Cloud Host and Local Agent strategy loaders | Policy release baseline |
| `config/practice-profiles.json` | `43fbb17436db3c7e0701ceefa3879b178e78a1b65ccffe96d8070d607854966a` | Cloud/Local runtime composition | Policy release baseline |

## Deployment-owned sources intentionally not inspected

- `config/llm-providers.json` and `local-agent-runtime/config/llm-providers.json`: local/deployment-owned provider documents; this work package neither reads nor hashes them.
- Runtime environment file resolved by `LOCAL_AGENT_RUNTIME_ENV_FILE` (default `.env` beneath the Local Agent runtime data root): its path is passed to `ENTERPRISE_INFO_ENV_FILE` and `STEEL_MARKET_DB_ENV_FILE`; its contents were not read.
- Cloud Host `STEEL_MARKET_DB_ENV_FILE` (defaults to `./.env`): path only, contents not read. WP-4 removed the Cloud Host `ENTERPRISE_INFO_ENV_FILE` child-process path; its historical deployment file was not read.
- `custom-skills/mysql-steel-data/.env.example`: credential-free template. Any corresponding `.env` is deployment-owned and was not read.
- Kubernetes `secret.example.yaml` is a template; no real Kubernetes Secret, mounted provider configuration, or Compose environment was read.

## Configuration reference names and consumers

| Reference | Consumers observed in source | Planned scope |
| --- | --- | --- |
| `LLM_PROVIDER_CONFIG_PATH` / `LOCAL_AGENT_PROVIDER_CONFIG_PATH` | Cloud Host, Local Agent, Compose/Kubernetes manifests | Cloud/Local Integration + Model Route binding |
| `SKILL_DIRECTORIES_CONFIG_PATH` | Cloud Host, Local Agent, local launcher, Kubernetes manifest | Cloud/Local Skill assignment |
| `STEP_EXECUTION_STRATEGY_CONFIG_PATH` | Explicit file-mode/local launcher only | Cloud/Local Policy release |
| `PRACTICE_PROFILE_CONFIG_PATH` | Explicit file-mode/local launcher only | Cloud/Local Policy release |
| `ENTERPRISE_INFO_ENV_FILE` | Local Agent runtime configuration; historical Cloud Host path | Cloud `enterprise_info` now uses brokered binding; Local migration remains WP-5 |
| `STEEL_MARKET_DB_ENV_FILE` | Cloud Host command environment and Local Agent runtime configuration | Future data-source Integration binding; no secret/path delivery to Skills |

## WP-8 source policy

`RUNTIME_CONFIGURATION_SOURCE` and `LOCAL_RUNTIME_CONFIGURATION_SOURCE` now default to `control_plane`. The `file` value is an explicit development/bootstrap mode only. In `control_plane` mode Cloud Host and Local Agent do not load the Provider, Skill-directory, Step-strategy, Practice Profile JSON paths or deployment `.env` as runtime configuration; they use the signed delivery snapshot, target-local Skill catalog, and brokered credentials. Existing JSON and `.env` paths remain documented only for explicit bootstrap/rollback workflows and are not a per-field fallback.

Production Kubernetes manifests set `RUNTIME_CONFIGURATION_SOURCE=control_plane`, remove Provider config/env mounts, and require delivery workload identity. Compose remains an explicit local `file` profile unless overridden for a control-plane canary.
