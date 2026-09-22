import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { get as httpsGet } from 'node:https';
import { Resolver } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { defaultSettings, validateSettings, resolveHosting, configureHosting } from './hosting-policy.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(root, 'server-settings.json');
const settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) };
let usedPublicDns = false;
async function checkPublicHealth(origin) {
  try {
    const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
    return response.ok && (await response.json()).data?.human_matchmaking === true;
  } catch (error) {
    if (!['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code)) return false;
    // Some home DNS resolvers reject new temporary hostnames. Resolve only this
    // health check through Cloudflare DNS; do not change Windows DNS or TLS trust.
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const addresses = await resolver.resolve4(new URL(origin).hostname);
    usedPublicDns = true;
    return await new Promise(resolve => {
      const request = httpsGet(origin + '/healthz', { timeout: 5000,
        lookup: (_host, options, callback) => options.all ? callback(null, [{ address: addresses[0], family: 4 }]) : callback(null, addresses[0], 4),
      }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; if (body.length > 65536) request.destroy(); });
        response.on('end', () => { try { resolve(response.statusCode === 200 && JSON.parse(body).data?.human_matchmaking === true); } catch { resolve(false); } });
        response.on('error', () => resolve(false));
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(false));
    });
  }
}
validateSettings(settings);
const mode = process.argv[2] || 'start';
if (mode === 'configure') {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Named hosting preserves a stable Cloudflare tunnel and uses a separately supplied private token. Domain mode uses Caddy and needs router forwarding of TCP 80/443. Local is laptop-only. Quick is explicitly temporary. This tool does not change your router, firewall or private token. Blank answers preserve current settings.');
    const hostingMode = await input.question(`Hosting mode: named/domain/local/quick (Enter keeps ${settings.hostingMode}): `);
    const publicHostname = await input.question(`Public hostname, without https:// (Enter keeps ${settings.publicHostname || 'empty'}): `);
    const chestSeconds = await input.question(`Chest duration in seconds, 1 to 604800 (Enter keeps ${settings.chestUnlockMilliseconds / 1000}): `);
    const configured = configureHosting(settings, { hostingMode, publicHostname, chestSeconds });
    fs.writeFileSync(settingsPath, JSON.stringify(configured, null, 2) + '\n');
    console.log('Saved. Stop any running server, then double-click Start Server.cmd.');
  } finally { input.close(); }
} else if (mode === 'backup') {
  const { createBackup } = await import('./server/database-backup.mjs');
  const result = await createBackup({ sourcePath: path.join(root, 'player-data', 'kiwi-duel.sqlite'), destinationDirectory: path.join(root, 'backups') });
  console.log('Backup completed in the backups folder. Keep it private.');
} else if (['start', 'online', 'local', 'quick'].includes(mode)) {
  const hosting = resolveHosting(settings, mode);
  const { quick, named, domain } = hosting;
  const tokenFile = path.join(root, 'tunnel-token.private');
  if (named) {
    // Fail before creating player data, probing ports or starting any component.
    // Do not inspect or print the token contents, and do not fall back to quick.
    let tokenInfo;
    try { tokenInfo = fs.lstatSync(tokenFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw Error('Missing tunnel-token.private. Named hosting keeps the permanent address and will not fall back to a temporary tunnel. The owner must supply the private token locally; see README.txt.');
    }
    if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.size === 0) throw Error('tunnel-token.private must be a nonempty regular local file, not a link.');
  }
  if (process.versions.node.split('.')[0] !== '24') throw Error('Use the bundled Node 24 runtime.');
  // Do not inherit development fixtures, account seeds, Node injection flags or proxy settings.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DUEL_|NODE_|XDG_)/i.test(key)));
  let origin = hosting.origin;
  const playerData = path.join(root, 'player-data');
  fs.mkdirSync(playerData, { recursive: true });
  Object.assign(env, {
    NODE_ENV: (domain || quick || named) ? 'production' : 'development',
    DUEL_SERVER_HOST: '127.0.0.1', DUEL_SERVER_PORT: String(settings.httpPort),
    DUEL_GAME_SERVER_HOST: '127.0.0.1', DUEL_GAME_SERVER_PORT: String(settings.gamePort),
    DUEL_SERVER_PUBLIC_BASE: origin, DUEL_GAME_SERVER_PUBLIC_HOST: (domain || named) ? settings.publicHostname : '127.0.0.1',
    DUEL_ACCOUNT_DATABASE: path.join(playerData, 'kiwi-duel.sqlite'),
    DUEL_DEFAULT_MATCH_MODE: 'human', DUEL_CHEST_UNLOCK_MS: String(settings.chestUnlockMilliseconds),
    DUEL_TRUSTED_PROXY_ADDRESSES: (domain || quick || named) ? '127.0.0.1,::1,::ffff:127.0.0.1' : '',
    DUEL_GAME_BATTLE_EVIDENCE_MODE: 'off', DUEL_GAME_OPPONENT_PLATE_MODE: 'off',
    XDG_DATA_HOME: path.join(root, 'https-data'), XDG_CONFIG_HOME: path.join(root, 'https-config'),
  });
  if (settings.contentRoot) env.DUEL_CONTENT_ROOT = path.join(root, ...settings.contentRoot.split('/'));
  for (const port of [settings.httpPort, settings.gamePort]) {
    await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', () => reject(Error(`Port ${port} is in use. Stop the other server first.`))); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  }
  const children = [];
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    try { fs.unlinkSync(path.join(root, 'SERVER-ADDRESS.txt')); } catch {}
    for (const child of children) if (child.exitCode === null) child.kill();
    setTimeout(() => process.exit(code), 1200);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
  const commands = createInterface({ input: process.stdin, output: process.stdout });
  commands.on('line', line => { if (line.trim().toLowerCase() === 'stop') stop(); });
  function run(exe, args) {
    const child = spawn(exe, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    children.push(child);
    child.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => { if (!stopping) { console.error(`A server component stopped (exit ${code}).`); stop(1); } });
    return child;
  }
  const caddy = path.join(root, 'runtime', 'caddy.exe');
  const caddyfile = path.join(root, 'Caddyfile.generated');
  if (domain) {
    fs.writeFileSync(caddyfile, `{\n admin off\n}\n${settings.publicHostname} {\n header -Server\n reverse_proxy 127.0.0.1:${settings.httpPort} {\n  header_up X-Forwarded-For {remote_host}\n  stream_close_delay 30s\n }\n}\n`);
    const check = spawnSync(caddy, ['validate', '--config', caddyfile, '--adapter', 'caddyfile'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (check.status !== 0) throw Error('HTTPS configuration failed validation.');
  }
  try {
  if (quick) {
    console.log('Creating a temporary HTTPS beta address through Cloudflare. No router changes are needed.');
    const tunnelHome = path.join(root, 'tunnel-home');
    fs.mkdirSync(tunnelHome, { recursive: true });
    // Isolate this portable process from any existing named-tunnel configuration.
    const tunnelEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^TUNNEL_/i.test(key)));
    tunnelEnv.USERPROFILE = tunnelHome;
    tunnelEnv.HOME = tunnelHome;
    const tunnel = spawn(path.join(root, 'runtime/cloudflared.exe'), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${settings.httpPort}`], { cwd: root, env: tunnelEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(tunnel);
    let tunnelOutput = '';
    let tunnelError;
    const collect = data => { tunnelOutput = (tunnelOutput + data.toString()).slice(-16000); };
    tunnel.stdout.on('data', collect);
    tunnel.stderr.on('data', collect);
    tunnel.on('error', error => { tunnelError = error; });
    tunnel.on('exit', code => { if (!stopping) { console.error(`Internet tunnel stopped (exit ${code}). Restart the server to get a new address.`); stop(1); } });
    let address;
    for (let attempt = 0; attempt < 180 && !stopping; attempt++) {
      if (tunnelError) throw tunnelError;
      address = tunnelOutput.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/)?.[0];
      if (address) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!address || stopping) throw Error('Could not create the internet tunnel. Check this laptop\'s internet connection.\n' + tunnelOutput);
    origin = address;
    env.DUEL_SERVER_PUBLIC_BASE = origin;
    env.DUEL_GAME_SERVER_PUBLIC_HOST = new URL(origin).hostname;
  }
  if (named) {
    for (const key of Object.keys(env)) if (/^TUNNEL_/i.test(key)) delete env[key];
    run(path.join(root, 'runtime/cloudflared.exe'), ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token-file', tokenFile]);
  }
  run(process.execPath, ['server/custom-bootstrap-server.mjs']);
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${settings.httpPort}/healthz`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      healthy = response.ok && body.data?.human_matchmaking === true;
      if (healthy) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!healthy) { console.error('Server did not become healthy. Read the error above.'); stop(1); }
  else {
    if (domain) run(caddy, ['run', '--config', caddyfile, '--adapter', 'caddyfile']);
    if (quick || named) {
      console.log('Server started locally. Checking the public HTTPS connection...');
      let reachable = false;
      for (let attempt = 0; attempt < 40 && !stopping; attempt++) {
        try {
          reachable = await checkPublicHealth(origin);
          if (reachable) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!reachable || stopping) throw Error('Public HTTPS check failed. Check your internet connection, then restart the server.');
    }
    fs.writeFileSync(path.join(root, 'SERVER-ADDRESS.txt'), `Game server: ${origin}\nAccount page: ${origin}/account\n${quick ? 'Temporary beta address: changes each restart. Configure clients with the current address.\n' : ''}`);
    console.log(`\nSERVER RUNNING\nAccount page: ${origin}/account\nAccounts: player-data folder\nType STOP and press Enter, or press Ctrl+C to stop. Keep this laptop awake while testers play.`);
    console.log(quick ? `INTERNET READY\nGame server: ${origin}\nAddress saved in SERVER-ADDRESS.txt. This temporary address changes after restart. Each game client needs the current HTTPS address. Cloudflare Quick Tunnels are for testing, with no uptime guarantee and a 200 concurrent request limit.` : named ? 'INTERNET READY: permanent address. Keep this laptop awake and this server running.' : domain ? 'HTTPS startup is in progress. Verify the address from a phone using mobile data before inviting testers.' : 'Laptop-only mode. Run Start Online Server.cmd for remote access. The existing game downloads still need the correct server address configured.');
    if (usedPublicDns) console.log('Your Windows DNS could not resolve this new address. The public HTTPS check passed using Cloudflare DNS. If this laptop browser cannot open it, try the account page on your phone; no Windows DNS settings were changed.');
    if (!process.argv.includes('--no-browser')) spawn('explorer.exe', [origin + '/account'], { windowsHide: true }).on('error', () => {});
  }
  } catch (error) { console.error(error.message); stop(1); }
} else throw Error('Unknown launcher action.');
