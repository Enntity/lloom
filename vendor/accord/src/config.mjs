// SPDX-License-Identifier: MIT
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { token, requireThat } from './common.mjs';
import { Store } from './store.mjs';
import { ArtifactDriver } from './driver.mjs';

export function initialize(directory, {fixtures=false}={}) {
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireThat(!existsSync(join(dir, 'config.json')) && !existsSync(join(dir, 'coordinator.sqlite')) && !existsSync(join(dir, 'driver.sqlite')),
    'ALREADY_INITIALIZED', 'Use a new empty data directory; existing state is never replaced');
  const secrets = {};
  for (const name of ['admin',...(fixtures?['agent-a','agent-b']:[]),'driver-control','claim-secret','bootstrap','discovery']) {
    secrets[name] = token();
    writeFileSync(join(dir, `${name}.token`), secrets[name], { mode: 0o600, flag: 'wx' });
  }
  const store = new Store(join(dir, 'coordinator.sqlite'));
  const authority = store.authority;
  try {
    for (const name of ['admin',...(fixtures?['agent-a','agent-b']:[])]) store.provision(name, secrets[name], name === 'admin' ? 'admin' : 'worker');
    store.provisionCredential('bootstrap', secrets.bootstrap, 'enroll');
    store.provisionCredential('discovery', secrets.discovery, 'discover');
  } finally { store.close(); }
  const driver = new ArtifactDriver(join(dir, 'driver.sqlite'));
  const driverInstance = driver.status().instance; driver.close();
  const config = { schema: 1, driverInstance, authority };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { dir, driverInstance, authority };
}
export function configuration(directory) {
  const dir = resolve(directory), config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  requireThat(config.schema === 1, 'CONFIG_VERSION', 'Unsupported configuration', 400);
  return { dir, ...config, readToken: name => readFileSync(join(dir, `${name}.token`), 'utf8').trim() };
}

// Additive upgrade for the original preview data directory. Never replace a credential.
export function ensureBootstrap(directory) {
  const config = configuration(directory), store = new Store(join(config.dir, 'coordinator.sqlite'));
  try {
    for (const [name, purpose] of [['bootstrap','enroll'], ['discovery','discover']]) {
      const path = join(config.dir, `${name}.token`);
      if (!existsSync(path)) writeFileSync(path, token(), {mode:0o600, flag:'wx'});
      const value = readFileSync(path, 'utf8').trim();
      const old = store.db.prepare('SELECT id FROM credentials WHERE id=?').get(name);
      if (!old) store.provisionCredential(name, value, purpose);
      store.purpose(value, purpose);
    }
    if (!config.authority) {
      const saved = JSON.parse(readFileSync(join(config.dir, 'config.json'), 'utf8'));
      writeFileSync(join(config.dir, 'config.json'), JSON.stringify({...saved,authority:store.authority},null,2)+'\n', {mode:0o600});
    }
    requireThat(!config.authority || config.authority === store.authority, 'AUTHORITY_MISMATCH', 'Configured host identity changed');
    return store.authority;
  } finally { store.close(); }
}
