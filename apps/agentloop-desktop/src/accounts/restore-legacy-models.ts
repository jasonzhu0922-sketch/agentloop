import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { AppDatabase, SqliteConnection } from "@zhujun/agentloop";
import { LocalModelConfigurationStore } from "@zhujun/agentloop-local-runtime/host";
import { EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";
import type { LocalModelConfigurationInput } from "@zhujun/agentloop-local-runtime";
import { accountDataDirectory } from "./account-managers.ts";
import { claimInstance } from "../platform/instance-lock.ts";

/** Explicit local-operator recovery only. Never called by login/migration:
 * legacy model credentials have no owner and must not be copied to each user.
 */
export async function restoreLegacyModels(dataDirectory: string, owner: string) {
  const destination = accountDataDirectory(dataDirectory, owner);
  const markerPath = join(destination, "account.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  if (marker.version !== 1 || marker.ownerUserId !== owner) throw new Error("desktop_account_marker_invalid");
  const claim = await claimInstance(dataDirectory, "development");
  if (claim.existing) throw new Error("desktop_stop_before_model_recovery");
  let target: AppDatabase | undefined;
  try {
    const old = new DatabaseSync(join(dataDirectory, "supervisor.db"), { readOnly: true });
    let row: { configuration_json: string; secret_storage_key: string | null } | undefined;
    try { row = old.prepare("SELECT configuration_json,secret_storage_key FROM local_model_configuration WHERE singleton=1").get() as typeof row; }
    finally { old.close(); }
    if (!row) throw new Error("legacy_model_configuration_missing");
    const configuration = JSON.parse(row.configuration_json) as LocalModelConfigurationInput;
    if (!configuration.providers?.length) throw new Error("legacy_model_configuration_empty");
    const secrets = new EncryptedLocalRuntimeSecretStore(join(dataDirectory, "private", "model-secrets"));
    const values = row.secret_storage_key ? await secrets.read(row.secret_storage_key) : undefined;
    const providers = configuration.providers.map(provider => {
      const apiKey = values?.[`LOCAL_MODEL_KEY_${provider.key.toUpperCase().replace(/-/g, "_")}`];
      if (!apiKey) throw new Error("legacy_model_credentials_missing");
      return { ...provider, apiKey };
    });
    target = await AppDatabase.open({ connection: new SqliteConnection(join(destination, "supervisor.db")), schema: "none" });
    const models = new LocalModelConfigurationStore(target, new EncryptedLocalRuntimeSecretStore(join(destination, "private", "model-secrets")));
    await models.ready();
    // Even a deliberately saved empty configuration is newer user intent.
    if ((await models.snapshot()).row) throw new Error("account_model_configuration_already_exists");
    const restored = await models.write({ reuseCloudModels: false, providers });
    const temporary = `${markerPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...marker, migration: { ...marker.migration, legacyModelsRestored: true } }), { mode: 0o600, flag: "wx" });
    await rename(temporary, markerPath);
    return { providers: restored.providers.length, models: restored.providers.reduce((count, provider) => count + provider.models.length, 0) };
  } finally {
    // Retain the instance fence if the database cannot close safely.
    await target?.close();
    await claim.lock.release();
  }
}
