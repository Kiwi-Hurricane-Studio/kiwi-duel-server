import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultSettings, permanentHostname, validateSettings, resolveHosting, configureHosting } from './hosting-policy.mjs';
import { assertCleanBundle, assertPublicPath, assertPublicRelative } from '../../scripts/portable-package-safety.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-portable-public-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('kiwi-portable-public-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'server-settings.json'), JSON.stringify(defaultSettings));
  return root;
}

test('clean public defaults preserve the permanent named host without secret fields', () => {
  const example = JSON.parse(fs.readFileSync(path.join(here, 'server-settings.example.json'), 'utf8'));
  assert.deepEqual(example, defaultSettings);
  assert.equal(defaultSettings.hostingMode, 'named');
  assert.equal(permanentHostname, 'play.kiwihurricanestudio.com');
  assert.equal(Object.keys(defaultSettings).length, 5);
});
for (const action of ['start', 'online']) {
  test(`${action} retains named hostname and never selects a temporary tunnel`, () => {
    const settings = structuredClone(defaultSettings);
    assert.deepEqual(resolveHosting(settings, action), { mode: 'named', named: true, domain: false, quick: false,
      origin: 'https://play.kiwihurricanestudio.com' });
    assert.deepEqual(settings, defaultSettings);
  });
  test(`${action} retains an explicitly configured domain`, () => {
    const hosted = resolveHosting({ ...defaultSettings, hostingMode: 'domain', publicHostname: 'duel.example.com' }, action);
    assert.equal(hosted.domain, true);
    assert.equal(hosted.origin, 'https://duel.example.com');
    assert.equal(hosted.quick, false);
  });
}
test('local override and temporary mode require explicit selection, not hostname truthiness', () => {
  assert.equal(resolveHosting(defaultSettings, 'local').origin, 'http://127.0.0.1:8080');
  assert.equal(resolveHosting({ ...defaultSettings, hostingMode: 'local' }).mode, 'local');
  assert.throws(() => resolveHosting({ ...defaultSettings, hostingMode: 'local' }, 'online'), /not configured/);
  assert.equal(resolveHosting(defaultSettings, 'quick').quick, true);
  assert.equal(resolveHosting({ ...defaultSettings, hostingMode: 'quick', publicHostname: '' }, 'online').quick, true);
});
test('configuration blank answers preserve the complete named setup', () => {
  assert.deepEqual(configureHosting(defaultSettings), defaultSettings);
  assert.deepEqual(configureHosting(defaultSettings, { hostingMode: ' ', publicHostname: ' ', chestSeconds: ' ' }), defaultSettings);
});
test('hostname or duration editing never converts named hosting to domain/local', () => {
  const edited = configureHosting(defaultSettings, { publicHostname: 'Other.Example.COM', chestSeconds: '20' });
  assert.equal(edited.hostingMode, 'named');
  assert.equal(edited.publicHostname, 'other.example.com');
  assert.equal(edited.chestUnlockMilliseconds, 20000);
  assert.equal(defaultSettings.publicHostname, permanentHostname);
});
test('configuration changes mode only through an explicit valid selection', () => {
  for (const mode of ['named', 'domain', 'local', 'quick']) {
    const edited = configureHosting(defaultSettings, { hostingMode: mode });
    assert.equal(edited.hostingMode, mode);
    assert.equal(edited.publicHostname, permanentHostname);
  }
  assert.throws(() => configureHosting(defaultSettings, { hostingMode: 'auto' }));
  assert.throws(() => configureHosting(defaultSettings, { chestSeconds: 'bad' }));
});

test('modular content hosting is an optional explicit public relative directory', t => {
  assert.equal(validateSettings(defaultSettings).contentRoot, undefined);
  assert.equal(validateSettings({ ...defaultSettings, contentRoot: 'content-releases/public' }).contentRoot, 'content-releases/public');
  for (const contentRoot of ['', '../private', '/content', 'C:/content', 'content\\nested', 'player-data', 'content/backups', 'con', 7]) {
    assert.throws(() => validateSettings({ ...defaultSettings, contentRoot }), /contentRoot/);
  }
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'server-settings.json'), JSON.stringify({ ...defaultSettings, contentRoot: 'content-releases' }));
  assert.deepEqual(assertCleanBundle(root), ['server-settings.json']);
  assert.equal(configureHosting({ ...defaultSettings, contentRoot: 'content-releases' }).contentRoot, 'content-releases');
});
for (const bad of [
  { hostingMode: 'invalid' }, { publicHostname: '' }, { publicHostname: 'https://play.kiwihurricanestudio.com' },
  { publicHostname: 'name.example { bad }' }, { publicHostname: 'name.local' }, { publicHostname: 'name.localhost' },
  { httpPort: 443 }, { gamePort: 8080 }, { gamePort: 70000 }, { chestUnlockMilliseconds: 0 },
]) test(`invalid public configuration rejected: ${Object.keys(bad)[0]} ${JSON.stringify(bad)}`, () => {
  assert.throws(() => validateSettings({ ...defaultSettings, ...bad }));
});
for (const action of ['start', 'online']) test(`${action} without a token fails before player data or server startup`, t => {
  const root = fixture(t);
  for (const name of ['launcher.mjs', 'hosting-policy.mjs']) fs.copyFileSync(path.join(here, name), path.join(root, name));
  const child = spawnSync(process.execPath, [path.join(root, 'launcher.mjs'), action, '--no-browser'], {
    windowsHide: true, timeout: 5000, encoding: 'utf8', env: { ...process.env, TUNNEL_TOKEN: 'synthetic-inherited-value-must-not-appear' },
  });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Missing tunnel-token\.private/);
  assert.match(child.stderr, /will not fall back/);
  assert.doesNotMatch(child.stdout + child.stderr, /synthetic-inherited-value-must-not-appear|SERVER RUNNING|trycloudflare\.com/);
  assert.equal(fs.existsSync(path.join(root, 'player-data')), false);
  assert.equal(fs.existsSync(path.join(root, 'SERVER-ADDRESS.txt')), false);
});
test('configured private installation is refused lexically without inspecting it', () => {
  for (const target of ['C:\\Users\\kiwi_\\Downloads\\Kiwi-Duel-Permanent-Server',
    'c:/users/KIWI_/downloads/kiwi-duel-permanent-server/player-data',
    'C:\\Users\\kiwi_\\Downloads\\Kiwi-Duel-Permanent-Server\\server-settings.json']) {
    assert.throws(() => assertPublicPath(target, { allowMissing: true }), /configured permanent server is private/);
  }
});
for (const relative of ['tunnel-token.private', 'player-data/anything', 'backups/anything', 'server/runtime/anything',
  'server-secrets.json', 'setup-credentials.json', 'credentials.txt', 'server/token.json', '.cloudflared/config.yml',
  'server-profiles.local.json', 'account.sqlite-wal', '.env', '.private/credentials.json',
  'certificate.pem', 'a/../b', 'C:/data/file.json', 'server\\launcher.mjs']) {
  test(`runtime allowlist rejects private or unsafe path: ${relative}`, () => assert.throws(() => assertPublicRelative(relative)));
}
test('clean bundle accepts only public settings and rejects private names before reading config', t => {
  const root = fixture(t);
  assert.deepEqual(assertCleanBundle(root), ['server-settings.json']);
  fs.writeFileSync(path.join(root, 'server-settings.json'), 'not even JSON');
  fs.mkdirSync(path.join(root, 'player-data'));
  assert.throws(() => assertCleanBundle(root), /Private or unsafe/);
});
test('unexpected settings fields cannot enter a clean release', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'server-settings.json'), JSON.stringify({ ...defaultSettings, setupCredential: 'synthetic' }));
  assert.throws(() => assertCleanBundle(root), /unexpected fields/);
});
test('junctions are refused as package roots, descendants and future output ancestors', t => {
  const root = fixture(t);
  const link = path.join(root, 'redirect');
  const target = path.join(root, 'ordinary');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertPublicPath(link), /symbolic link or junction/);
  assert.throws(() => assertPublicPath(path.join(link, 'new-output'), { allowMissing: true }), /symbolic link or junction/);
  assert.throws(() => assertCleanBundle(root), /symbolic link or junction/);
});
test('public online test refuses to label the permanent service disposable before network setup', () => {
  const script = path.resolve(here, '../../scripts/test-portable-online.mjs');
  const child = spawnSync(process.execPath, [script, 'https://play.kiwihurricanestudio.com', '--disposable-test-server'], {
    windowsHide: true, timeout: 5000, encoding: 'utf8',
  });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /authorized-persistent-test-accounts/);
  assert.doesNotMatch(child.stdout, /result.*pass/);
});
