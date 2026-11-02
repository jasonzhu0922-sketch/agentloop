import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorModule, ConnectorModuleFactoryContext } from "@zhujun/agentloop-connector-sdk";

export interface ConnectorModuleRegistration {
  readonly modulePath: string;
  readonly exportName?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ConnectorModuleLoaderOptions {
  readonly baseDirectory?: string;
  readonly registrations?: readonly ConnectorModuleRegistration[];
}

export async function loadConnectorModules(
  options: ConnectorModuleLoaderOptions = {},
): Promise<readonly ConnectorModule[]> {
  const registrations = options.registrations ?? registrationsFromEnvironment();
  const baseDirectory = options.baseDirectory ?? process.cwd();
  const modules: ConnectorModule[] = [];
  for (const registration of registrations) {
    const moduleUrl = isAbsolute(registration.modulePath)
      ? pathToFileURL(registration.modulePath).href
      : pathToFileURL(resolve(baseDirectory, registration.modulePath)).href;
    const loaded = await import(moduleUrl) as Record<string, unknown>;
    const exported = registration.exportName === undefined
      ? loaded.default ?? loaded.connectorModule
      : loaded[registration.exportName];
    const factoryContext: ConnectorModuleFactoryContext = {
      modulePath: registration.modulePath,
      config: registration.config ?? {},
      fetch: globalThis.fetch,
    };
    const module = typeof exported === "function"
      ? await (exported as (context: ConnectorModuleFactoryContext) => Promise<ConnectorModule> | ConnectorModule)(factoryContext)
      : exported;
    if (!isConnectorModule(module)) {
      throw new Error(`Configured Connector module is invalid: ${registration.modulePath}`);
    }
    modules.push(module);
  }
  return modules;
}

export function registrationsFromEnvironment(
  value = process.env.CONNECTOR_MODULES_JSON,
): readonly ConnectorModuleRegistration[] {
  if (value === undefined || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CONNECTOR_MODULES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("CONNECTOR_MODULES_JSON must be an array");
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`CONNECTOR_MODULES_JSON[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.modulePath !== "string" || record.modulePath.trim().length === 0) {
      throw new Error(`CONNECTOR_MODULES_JSON[${index}].modulePath is required`);
    }
    if (record.exportName !== undefined && typeof record.exportName !== "string") {
      throw new Error(`CONNECTOR_MODULES_JSON[${index}].exportName must be a string`);
    }
    if (record.config !== undefined && (typeof record.config !== "object" || record.config === null || Array.isArray(record.config))) {
      throw new Error(`CONNECTOR_MODULES_JSON[${index}].config must be an object`);
    }
    return {
      modulePath: record.modulePath,
      ...(record.exportName === undefined ? {} : { exportName: record.exportName }),
      ...(record.config === undefined ? {} : { config: record.config as Readonly<Record<string, unknown>> }),
    };
  });
}

function isConnectorModule(value: unknown): value is ConnectorModule {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Partial<ConnectorModule>;
  return typeof module.connect === "function"
    && typeof module.project === "function"
    && typeof module.definition === "object"
    && module.definition !== null;
}
