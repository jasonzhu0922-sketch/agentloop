import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { ConnectorModuleRegistration } from "@zhujun/agentloop-local-runtime/connectors";

/**
 * Connector code approved by the Desktop host.
 *
 * The browser never supplies these locations. Development uses the workspace
 * sources; an installed Desktop can ship matching bundles in `connectors/`.
 */
export function builtinConnectorModules(appRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))): readonly ConnectorModuleRegistration[] {
  return [
    registration(appRoot, "feishu", "connector-feishu", "feishuConnector"),
    registration(appRoot, "126-mail", "connector-126-mail", "createConfigured126MailConnector"),
    registration(appRoot, "wps", "connector-wps", "createConfiguredWpsConnector"),
  ];
}

function registration(
  appRoot: string,
  bundleName: string,
  workspacePackage: string,
  exportName: string,
): ConnectorModuleRegistration {
  const bundled = join(appRoot, "connectors", `${bundleName}.mjs`);
  return {
    modulePath: existsSync(bundled)
      ? bundled
      : resolve(appRoot, "..", "..", "packages", workspacePackage, "src", "index.ts"),
    exportName,
  };
}
