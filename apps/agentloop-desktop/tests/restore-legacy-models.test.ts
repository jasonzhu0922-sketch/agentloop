import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore } from '@zhujun/agentloop-local-runtime';
import { claimInstance } from '../src/platform/instance-lock.ts';
import { accountDataDirectory, DesktopAccountManagers } from '../src/accounts/account-managers.ts';
import { restoreLegacyModels } from '../src/accounts/restore-legacy-models.ts';

const alice = `cloud_${'a'.repeat(64)}`, bob = `cloud_${'b'.repeat(64)}`;
test('explicit legacy model recovery targets one account, re-encrypts credentials and survives reopening without overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-restore-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claim = await claimInstance(root, 'development'); if (claim.existing) throw new Error('unexpected_instance'); await claim.lock.release();
  const skills = join(root, 'bundled'); await mkdir(skills);
  const sourceSecrets = new EncryptedLocalRuntimeSecretStore(join(root, 'private', 'model-secrets'));
  const legacy = await createLocalRuntimeManager({ dataDirectory: root, defaultRuntimeId: 'desktop-default', bundledSkillDirectories: [skills], modelSecrets: sourceSecrets });
  const settings = await legacy.modelConfiguration();
  await legacy.configureModels({ reuseCloudModels: false, providers: [{ key: 'fixture', displayName: 'Fixture', baseUrl: 'https://model.example.test/v1', apiKey: 'synthetic-legacy-api-key',
    models: [{ key: 'first', displayName: 'First', providerModel: 'first', protocol: 'responses', contextWindowTokens: 128000, maxOutputTokens: 8192 },
      { key: 'second', displayName: 'Second', providerModel: 'second', protocol: 'chat-completions', contextWindowTokens: 128000, maxOutputTokens: 8192 }] }] }, settings.revision);
  await legacy.close();
  const sourceBefore = await readFile(join(root, 'supervisor.db'));
  const accounts = new DesktopAccountManagers({ dataDirectory: root, defaultRuntimeId: 'desktop-default', bundledSkillDirectories: [skills] });
  await accounts.ready();
  assert.deepEqual((await (await accounts.forOwner(alice)).modelConfiguration()).configuration.providers, []);
  assert.deepEqual((await (await accounts.forOwner(bob)).modelConfiguration()).configuration.providers, []);
  await accounts.close();
  assert.deepEqual(await restoreLegacyModels(root, alice), { providers: 1, models: 2 });
  await assert.rejects(restoreLegacyModels(root, alice), /account_model_configuration_already_exists/);
  const reopened = new DesktopAccountManagers({ dataDirectory: root, defaultRuntimeId: 'desktop-default', bundledSkillDirectories: [skills] });
  try {
    await reopened.ready();
    const restored = await (await reopened.forOwner(alice)).modelConfiguration();
    assert.deepEqual(restored.configuration.providers[0]!.models.map(model => model.key), ['first', 'second']);
    assert.equal(restored.configuration.providers[0]!.credentialConfigured, true);
    assert.equal('apiKey' in restored.configuration.providers[0]!, false);
    assert.deepEqual((await (await reopened.forOwner(bob)).modelConfiguration()).configuration.providers, []);
  } finally { await reopened.close(); }
  const destination = accountDataDirectory(root, alice);
  const db = new DatabaseSync(join(destination, 'supervisor.db'), { readOnly: true });
  let reference: string;
  try { reference = String(db.prepare('SELECT secret_storage_key FROM local_model_configuration WHERE singleton=1').get()!.secret_storage_key); }
  finally { db.close(); }
  const targetSecrets = new EncryptedLocalRuntimeSecretStore(join(destination, 'private', 'model-secrets'));
  assert.equal((await targetSecrets.read(reference!))!.LOCAL_MODEL_KEY_FIXTURE, 'synthetic-legacy-api-key');
  assert.notDeepEqual(await readFile(join(destination, 'private', 'model-secrets', 'master.key')), await readFile(join(root, 'private', 'model-secrets', 'master.key')));
  assert.equal((await readFile(join(destination, 'supervisor.db'))).includes(Buffer.from('synthetic-legacy-api-key')), false);
  assert.deepEqual(await readFile(join(root, 'supervisor.db')), sourceBefore);
  assert.equal(JSON.parse(await readFile(join(destination, 'account.json'), 'utf8')).migration.legacyModelsRestored, true);
  for (const key of await sourceSecrets.listKeys()) await sourceSecrets.remove(key);
  await assert.rejects(restoreLegacyModels(root, bob), /legacy_model_credentials_missing/);
  const untouched = new DatabaseSync(join(accountDataDirectory(root, bob), 'supervisor.db'), { readOnly: true });
  try { assert.equal(untouched.prepare('SELECT COUNT(*) AS count FROM local_model_configuration').get()!.count, 0); }
  finally { untouched.close(); }
});
