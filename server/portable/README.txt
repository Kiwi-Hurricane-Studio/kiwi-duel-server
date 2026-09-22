KIWI DUEL - PORTABLE SERVER

Windows 10/11 x64. Extract the entire ZIP into a writable folder outside
OneDrive. Do not run it from inside the ZIP. No Node/Docker installation needed.

PERMANENT ONLINE SERVICE

Game server: https://play.kiwihurricanestudio.com
Account page: https://play.kiwihurricanestudio.com/account
The owner currently hosts this service on their laptop using the named
Cloudflare tunnel kiwi-duel-laptop. Both game clients use custom, HTTPS, port 443.
Players should connect to that service; they do not need to run this package.

New full server packages retain hostingMode: named and the permanent public
hostname in server-settings.json. They contain NO tunnel token, existing
accounts, setup credentials, certificate storage, or local device links.
Only the tunnel owner can provide tunnel-token.private privately in the
extracted server folder. Never send that file to players or add it to a ZIP,
Git commit, screenshot, report or uploaded support bundle. Do not paste its
contents on a command line. The launcher passes only its filename to cloudflared.

An extracted clean package will refuse to start without that private file.
This is intentional: it will not switch the permanent service to a temporary
address. Start Server.cmd and Start Online Server.cmd both honor named hosting.
Keep only ONE active instance for this service/database. Do not start a second
copy against the same account database or tunnel just to test an update.

START / STOP (OWNER ONLY, AFTER PRIVATE SETUP)

1. Stop the previous instance cleanly and preserve its full private folder.
2. Double-click Start Server.cmd (or Start Online Server.cmd).
3. Wait for INTERNET READY. The account page opens and the permanent address
   is written to SERVER-ADDRESS.txt after the public HTTPS health check passes.
4. Keep the console open and the laptop awake. Type STOP then Enter to stop.
5. In the game, open account linking and compare the six-digit verification
   code shown in the game with the browser before approving that device.

If Windows blocks a command file, open PowerShell in the extracted folder:

& '.\runtime\node.exe' '.\launcher.mjs' start

Do not turn off Windows security protections. If a bundled executable is
blocked, record the error for support. HTTP and raw game listeners stay on
127.0.0.1; only the HTTPS account/API and secure WebSocket service is tunneled.
Do not forward backend ports 8080/8081 publicly.

UPGRADING WITHOUT LOSING ACCOUNTS OR LINKS

Run the old installation's backup command, then stop it. Keep the old folder
intact. Before starting the new copy, privately preserve/migrate its entire
player-data folder, server-settings.json, tunnel-token.private, and any
https-data/https-config certificate folders used by domain hosting. Do not
replace configured settings with release defaults and do not run both copies
against one database. Device links are retained by the account database; game
server-profiles.local.json and server-secrets.json stay private on each device.

The configured C:\Users\kiwi_\Downloads\Kiwi-Duel-Permanent-Server folder is a
PRIVATE live installation, NOT a release source. Never zip or distribute it.
Build clean releases with the repository's package-portable-server.ps1 instead.
Its allowlist excludes tokens, account databases, backups and local settings.

Backup command, from PowerShell in the private server folder:
& '.\runtime\node.exe' '.\launcher.mjs' backup

Backups go into backups. Save them privately off the laptop. They preserve
accounts and completed results, not active matches. Never ship a backup.

OTHER EXPLICIT HOSTING MODES

Start Laptop Only.cmd (or launcher.mjs local) explicitly runs privately on
127.0.0.1. It does not rewrite the saved named settings. For a different stable
hostname, supply your own publicHostname and named tunnel's private token; do
not reuse the owner's hostname/token for an unrelated server.

Configure Internet Hosting.cmd asks for an explicit named/domain/local/quick
choice; blank answers keep the current mode, hostname and duration. Changing a
hostname alone does not change named mode. The separate direct-domain/Caddy
mode needs DNS at your public IP, router forwarding of TCP 80/443 and appropriate
Windows Firewall permissions; it may fail under CGNAT. Preserve https-data and
https-config for certificates. This is an explicit configuration change.

For an explicitly disposable test service only, launcher.mjs quick selects
Cloudflare Quick Tunnel hosting. This changes its temporary address every
restart; it has no uptime guarantee and a 200 concurrent request limit. Do
not use quick for the permanent Kiwi Duel service. No failed named startup
falls back to quick or local. A failed component stops the other components.

PUBLIC HEALTH AND TEST COVERAGE

The public HTTPS health check retains normal TLS validation. If system DNS
returns ENOTFOUND/EAI_AGAIN, only that check may use Cloudflare DNS, without
changing Windows DNS. The launcher reports this limitation. A fallback check
does not prove that every player's network resolves the hostname.

September 11/12 evidence covers public HTTPS signup/login and explicit linking,
secure cookies, foreign-origin rejection, two-player matchmaking and two
authenticated WSS protocol clients. The physical phone connected successfully.
A full phone-versus-laptop played battle remains an acceptance boundary.
Package checks use isolated disposable copies, not real accounts or devices.
See validation reports for exact source/build dates and limitations.

This remains an incomplete game port. Other-Z and mixed KO/Rock Slide rule
limitations remain. Human matchmaking needs two players. Laptop sleep, loss
of internet or stopping the server interrupts games.

Runtime licenses are in runtime and server/node_modules/ws/LICENSE.

MODULAR CLIENT CONTENT (OPTIONAL)

The new server runtime can serve reviewed client releases before account login.
Keep a separately built public content directory beside launcher.mjs, for example
content-releases, with manifests/windows.json, manifests/android.json and blobs/.
Add "contentRoot": "content-releases" to server-settings.json to enable it.
The default clean server download leaves this setting absent. The directory must
be relative to the server folder and cannot traverse links or private directories.
Never use player-data, backups, or the configured live server as a release input.

Publish all immutable blobs before atomically replacing a platform manifest.
The server validates target and blob hashes before serving the manifest; absent,
corrupt or oversized content fails closed. Keep older blobs while clients may be
updating; replacing the platform manifest does not remove historical blob URLs.
Updates use /v1/content/manifest and /v1/content/blobs/<sha256> on this same origin.
See the project's modular updater documentation for the publisher and client
runtime compatibility boundary. Server executable/game-rule changes still need
a coordinated server deployment; publishing client content does not patch Node.
