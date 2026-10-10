# Shutu Data Asset Skill Rollout

This release adds a deliberately small, evidence-oriented Shutu set to
`custom-skills`. It is a starting point for ODS-to-DDM work, not a grant of
business-system write authority.

## Included packages

| Package | Role | Runtime dependency |
| --- | --- | --- |
| `shutu-ods-analysis` | Produce a single-table ODS modeling report from read evidence | `ontoflow-jtbc` and DB2 read permission |
| `shutu-ods-analysis-validate` | Verify report structure with the package script | Python 3.10+ |
| `shutu-ods-report-qc` | Check report evidence and content quality | Python 3.10+ |
| `shutu-ods-ddm-modeling` | Produce DDM report and collection-standard workbook from validated reports | Upstream three Skills, graph analysis and openpyxl |
| `shutu-ontology-ba-data-standard-mgmt` | Read-only interpretation of standard-management architecture | None |
| `shutu-ontology-ba-financial-mgmt` | Read-only interpretation of financial rules and architecture | None; expert review remains required |

Not included: direct MCP export scripts, data-classification batch tools,
business-action Skills, and MCP deployment manuals. They either require a
separate execution contract, handle sensitive data, define state changes, or
only document mock/deployment behavior.

## MCP activation

`config/mcp-servers.shutu.example.json` is a reviewed template for the one
shared data source used by the ODS analysis Skill: `ontoflow-jtbc` at
`http://10.82.75.22:8082/mcp`. It intentionally is not merged into the active
`mcp-servers.json` files. Do not activate it until the runtime network, the
service identity and `tools/list` have been verified.

For a Cloud Runtime Host, merge its server entry into the deployment-specific
MCP file selected by `MCP_SERVERS_CONFIG_PATH`, or into
`config/mcp-servers.json` for local development. Put
`ONTOFLOW_JTBC_API_KEY` only in the Host environment or secret store.

For a Local Runtime Agent, merge the same entry into that device's owned
`config/mcp-servers.json`, whose root can be overridden by
`LOCAL_AGENT_MCP_SERVERS_CONFIG_PATH`. Put `ONTOFLOW_JTBC_API_KEY` only in
that device's private `.env`. Host configuration is not inherited by the
Local Agent.

The configuration uses `headers_env`, which resolves `X-API-Key` from the
private environment at connection time. It allowlists only
`call_rdb_sql_api_query`; it never places the secret in a Skill, config file,
database record, plan, or model context.

## Acceptance gate

1. From the intended Host or Local Agent network, verify MCP `initialize` and
   `tools/list` return `call_rdb_sql_api_query`.
2. Verify the granted database principal has only the required catalog and
   table `SELECT` permissions. The Skill release rejects write SQL by
   instruction, but database permissions remain the enforcement boundary.
3. Restart the exact Runtime process after changing MCP configuration, then
   create a fresh Run and confirm the namespaced tool
   `mcp_ontoflow_jtbc_call_rdb_sql_api_query` is available.
4. Run the ODS analysis, validation and QC chain against a non-sensitive
   table before admitting it to a governed data domain.
