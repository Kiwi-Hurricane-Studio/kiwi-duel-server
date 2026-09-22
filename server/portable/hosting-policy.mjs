// Public configuration only. A named tunnel's private token is supplied locally,
// never embedded in source, profiles, a release, or a child-process argument.
export const permanentHostname = 'play.kiwihurricanestudio.com';
export const defaultSettings = Object.freeze({ hostingMode: 'named', publicHostname: permanentHostname,
  httpPort: 8080, gamePort: 8081, chestUnlockMilliseconds: 3000 });

export function validateSettings(s) {
  if (!['local', 'quick', 'domain', 'named'].includes(s.hostingMode)) throw Error('hostingMode must be local, quick, domain or named.');
  if (typeof s.publicHostname !== 'string' || (s.publicHostname && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s.publicHostname))) throw Error('Enter a DNS hostname such as game.example.com, without https:// or a port.');
  if (s.publicHostname === 'localhost' || s.publicHostname.endsWith('.localhost') || s.publicHostname.endsWith('.local')) throw Error('Use a public DNS hostname.');
  if (['named', 'domain'].includes(s.hostingMode) && !s.publicHostname) throw Error('Permanent hosting needs publicHostname.');
  for (const key of ['httpPort', 'gamePort']) if (!Number.isInteger(s[key]) || s[key] < 1024 || s[key] > 65535) throw Error(`${key} must be a port from 1024 to 65535.`);
  if (s.httpPort === s.gamePort) throw Error('The two ports must differ.');
  if (!Number.isInteger(s.chestUnlockMilliseconds) || s.chestUnlockMilliseconds < 1000 || s.chestUnlockMilliseconds > 604800000) throw Error('Chest duration must be between 1 second and 7 days.');
  if (s.contentRoot !== undefined && (typeof s.contentRoot !== 'string'
    || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(s.contentRoot)
    || s.contentRoot.split('/').some(part => /^(?:player-data|backups|https-data|https-config|runtime|server|tunnel-home|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part)))) {
    throw Error('contentRoot must be a public relative content directory, such as content-releases.');
  }
  return s;
}

export function resolveHosting(settings, action = 'start') {
  validateSettings(settings);
  if (!['start', 'online', 'local', 'quick'].includes(action)) throw Error('Unknown launcher start action.');
  // "Online" must not silently replace a permanent service with a Quick Tunnel.
  const mode = action === 'local' ? 'local' : action === 'quick' ? 'quick' : settings.hostingMode;
  if (action === 'online' && mode === 'local') throw Error('Online hosting is not configured. Configure named/domain hosting, or explicitly select quick for a disposable temporary server.');
  return { mode, named: mode === 'named', domain: mode === 'domain', quick: mode === 'quick',
    origin: ['named', 'domain'].includes(mode) ? `https://${settings.publicHostname}` : `http://127.0.0.1:${settings.httpPort}` };
}

export function configureHosting(settings, { hostingMode = '', publicHostname = '', chestSeconds = '' } = {}) {
  validateSettings(settings);
  // Blank answers preserve existing configuration. A hostname edit never
  // implicitly changes a named tunnel into Caddy/domain or local hosting.
  const next = { ...settings };
  if (hostingMode.trim()) next.hostingMode = hostingMode.trim().toLowerCase();
  if (publicHostname.trim()) next.publicHostname = publicHostname.trim().toLowerCase();
  if (chestSeconds.trim()) next.chestUnlockMilliseconds = Number(chestSeconds) * 1000;
  return validateSettings(next);
}
