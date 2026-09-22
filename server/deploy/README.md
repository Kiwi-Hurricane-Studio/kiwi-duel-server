# Owned-server deployment scaffold

Status (2026-09-10): source and isolated Node tests only. No cloud host, DNS,
certificate, paid resource, public deployment, live database backup, or live
restore has been created. Docker is unavailable on the development PC, so the
image build, Compose validation, Caddy validation, TLS, Linux volume permissions,
and external-device acceptance checks below remain release gates. This does not
claim full-game reconstruction or production battle-rule parity.

## Fixed topology

```text
Android / Windows / browser
          HTTPS / WSS :443
                  |
          Caddy (automatic TLS)
                  |
         HTTP 127.0.0.1:8080
                  |
          Node 24 owned server
                  |
        persistent SQLite volume

Caddy shares the app container's network namespace.
Raw battle TCP 127.0.0.1:8081 is private, not a public endpoint.
Only 80/tcp, 443/tcp and 443/udp are published on the namespace owner.
```

`/v1/battle/socket` is proxied without rewriting its path or stripping its
Authorization header. Caddy automatically handles WebSocket upgrades. Its
`stream_close_delay` governs proxy configuration-reload cleanup; it is **not** a
promise that matches survive a container or process restart.
[Caddy reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

Compose's `network_mode: service:app` supplies the shared namespace; the healthy
dependency prevents starting the proxy before the app's local health check.
Because the namespace belongs to `app`, recreate the stack together when replacing
that container, not just the proxy. There is no `host` networking and neither Node
port is published. [Docker Compose service documentation](https://docs.docker.com/reference/compose-file/services/)

The app trusts only exact loopback proxy peer addresses. Caddy overwrites
`X-Forwarded-For` with exactly one actual remote address, which matches
`account-site.mjs`'s exact-IP trust/rate-limit contract. Do not place a CDN or another
proxy ahead of this configuration without revisiting both sides of that contract.
The default Caddy access log is not enabled: account-link URLs may contain a code.
Do not enable request/body/header logging without a separately verified redaction
policy. Keep infrastructure logs private as well.

## Prerequisites and configuration

Use one authorized Linux host with Docker Engine and current Compose v2, enough
persistent disk for accounts plus backups, a real public DNS name pointing to it,
and inbound 80/tcp and 443/tcp (443/udp for HTTP/3). Keep SSH restricted by the host's
administrative policy. Caddy needs the DNS name and reachability for automatic
certificate issuance; its certificate state persists in `caddy_data` and
`caddy_config`. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

Copy `.env.example` to the ignored `server/deploy/.env` on that authorized host.
Do not commit this file. Fill in:

- `DUEL_PUBLIC_HOST`: DNS hostname only, no scheme, path, port, credentials or
  trailing slash. The placeholder intentionally fails startup validation.
- `DUEL_CHEST_UNLOCK_MS`: an explicit **owned-server policy**, in milliseconds,
  between 1000 and 604800000. No recovered original timing is claimed. The old
  3000 ms local-test default is deliberately not silently used in production.
- `NODE_IMAGE` and `CADDY_IMAGE`: replace the scaffold's moving tags with reviewed
  image references pinned to digests for the release. Keep Node on version 24;
  the entrypoint rejects other majors. Record image digests and source revision
  in the deployment record, and update them only through a tested release.

There are no pre-created users or committed login secrets. Users register and
link their own devices through the owned site's browser flow. Production forbids
`DUEL_SEED_ACCOUNTS_PATH`; never import Kaeru credentials, original account data,
or preserved APK/data backups into this service. Only the explicit environment
allowlist in Compose is passed to Node.

`start-production.mjs` validates the exact HTTPS origin, both loopback listeners,
persistent database path, trusted proxy addresses, human matchmaking, disabled
evidence modes, writable volume directories and policy **before** importing the
server or opening SQLite. These checks are additional to the original server's
production checks. The current image uses the unprivileged `node` user with a
read-only root filesystem, writable named volumes and private file creation
permissions. New named volumes inherit the image directory ownership; existing
volumes must already have the correct owner/permissions. Never recursively change
an unverified host path to fix a permissions error.

`Dockerfile.dockerignore` allows only runtime modules, package lock, seven required
game-data JSON files and the existing Mew branding icon. It does not send runtime
SQLite files, backups, `.private`, `.env`, APKs, or the original asset archive to
the build context. Docker supports Dockerfile-specific ignore files beside the
Dockerfile. [Docker build-context documentation](https://docs.docker.com/build/concepts/context/)

## Staging/release commands (not executed here)

Run from the `pokemon-duel-modern` project root after the operator has supplied
the host configuration. `compose.json` uses JSON syntax, a YAML-compatible Compose
document; the local tests parse it without adding a YAML dependency. The actual
Compose parser remains an explicit staging check.

```sh
node --test server/database-backup.test.mjs server/deploy/deployment.test.mjs
docker compose --env-file server/deploy/.env -f server/deploy/compose.json config --quiet
docker compose --env-file server/deploy/.env -f server/deploy/compose.json build --pull
docker compose --env-file server/deploy/.env -f server/deploy/compose.json up -d --wait app
docker compose --env-file server/deploy/.env -f server/deploy/compose.json run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --env-file server/deploy/.env -f server/deploy/compose.json up -d --wait
docker compose --env-file server/deploy/.env -f server/deploy/compose.json ps
```

The `run caddy validate` command uses the app namespace, so the sequence starts
**only the app** first and validates Caddy before exposing the site. Do not bypass
validation. Do not print a rendered
configuration into public logs. Never use `down -v`: it removes persistent volumes.
For updates, back up and schedule a maintenance window before recreating the stack.

The health check requires the owned `/healthz` shape and a successful zero-data
connection to private TCP 8081. This proves local listeners, not a TLS handshake,
authenticated battle, complete rule implementation, or a working external route.
Configure authorized external monitoring after staging acceptance; no scheduled
task or monitor is installed by this scaffold.

## Backups

The database is `/var/lib/kiwi-duel/kiwi-duel.sqlite` in `accounts`. Do not copy just
its main file while it is live: committed content may still be in a WAL sidecar.
The helper opens the source read-only and uses Node's SQLite online backup API.
That API can overwrite a destination, so the helper creates a unique private
directory first and never targets an existing database.
[Node SQLite backup/read-only API](https://nodejs.org/download/release/v24.8.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)

An operator-authorized live backup (not performed during development):

```sh
docker compose --env-file server/deploy/.env -f server/deploy/compose.json exec -T app node server/database-backup.mjs backup --source /var/lib/kiwi-duel/kiwi-duel.sqlite --output /var/backups/kiwi-duel
```

The result identifies a new `kiwi-duel-backup-*` directory containing
`database.sqlite` and `manifest.json`. Only that new database is changed to DELETE
journal mode, making it standalone. Validation recognizes the genuine legacy
11-table account schema, its 12-table anonymous-browser/public-session-ID
successor, and the current complete 15-table consent/history schema (with or
without the subsequent paired reusable-credential columns). Every profile must
contain all core account/inventory columns and primary keys; partial new-table,
session-metadata, or credential migrations are rejected. This permits a verified
**pre-migration** backup without opening the source through the account store or
adding any table. Validation includes integrity, foreign keys, the exact schema
fingerprint, file SHA-256, byte size, and counts for **all user-defined tables**,
including extra additive tables, but not SQLite's internal bookkeeping tables.
New v2 manifests record the recognized schema profile; existing v1 current-schema
archives remain verifiable and produce full v2 metadata on prepared restore.
Legacy restore preparation preserves the legacy schema, rather than migrating it.
No credentials,
account records or SQL bodies enter the manifest. A failed attempt is retained
without a success manifest; it is not a valid backup.

Replace `BACKUP_ID` with the exact returned directory name when verifying:

```sh
docker compose --env-file server/deploy/.env -f server/deploy/compose.json exec -T app node server/database-backup.mjs verify --database /var/backups/kiwi-duel/BACKUP_ID/database.sqlite --manifest /var/backups/kiwi-duel/BACKUP_ID/manifest.json
```

Verification rejects changed bytes, incorrect metadata, invalid schemas and
nonempty WAL/journal sidecars. Checksums detect accidental corruption, not a
malicious replacement of both the database and its unsigned manifest. Filesystem
access is a trusted-operator boundary; directories must not be shared with
untrusted writers. Linux mode 0700/0600 is requested; Windows ACL protection must
be supplied separately for snapshots copied to a Windows host.

Snapshots contain sensitive password hashes, session material and personal account
data even though the diagnostic output does not. Encrypt them and copy them to
an authorized private off-host destination. A second volume on the same host is
not disaster recovery. Choose backup cadence, retention, encryption/key custody,
capacity alerts and deletion policy before accepting real accounts; no automatic
pruning, uploader, paid storage or scheduler is configured here. Preserve Caddy
certificate volumes according to the same private backup policy.

## Restore rehearsal and recovery

The tool never installs a restore over a live file. Prepare a unique validated
copy first:

```sh
docker compose --env-file server/deploy/.env -f server/deploy/compose.json exec -T app node server/database-backup.mjs prepare-restore --database /var/backups/kiwi-duel/BACKUP_ID/database.sqlite --manifest /var/backups/kiwi-duel/BACKUP_ID/manifest.json --output /var/backups/kiwi-duel
```

This returns a new `kiwi-duel-restore-*` path, rechecks schema and counts, and stores
the source snapshot hash. Rehearse with a disposable **isolated** staging volume
and private host before recovery. For actual recovery an operator must:

1. Drain/stop traffic and stop **both** app and proxy. Preserve a final backup and
   the current database plus sidecars for rollback; verify exact volume identity.
2. Install the prepared database as `kiwi-duel.sqlite` into a **new empty** accounts
   volume, with node-user ownership/private permissions. Do not merge it with old
   WAL/SHM files or overwrite the rollback volume. This installation is deliberately
   manual and outside the helper's authority.
3. Point a reviewed temporary Compose volume override at the new volume, preserving
   the original volume for rollback. Start privately, verify health, expected
   counts, account login, inventory, decks and completed match result lookup.
4. Reopen traffic only after validation. A restored snapshot may revive sessions
   revoked after it was taken; evaluate revocation requirements as part of the
   recovery/security policy before accepting traffic.

Use the same tested server revision/schema first. The current store has additive
migrations but no established downgrade contract; do not assume an older image
can safely open a newer database. In-progress matches/queue/challenge state are
in memory and are **not** restored by an account database backup. Completed
matches and account/inventory/deck state are persisted; mid-match restart
continuity requires additional architecture. Do not deploy multiple app replicas
against this topology: active state is process-local and SQLite is single-host.

## Verification record and remaining release gates

Local command on Node 24.19.0, 2026-09-10:

```sh
node --test server/database-backup.test.mjs server/deploy/deployment.test.mjs
```

Result: 15 tests, 14 passed, 0 failed, 1 skipped. The skipped symlink test requires
unprivileged symlink creation, unavailable on this Windows account. All fixtures
are private OS-temp directories and all cleanup is scoped to those directories;
no existing account data or live listeners are used. Tests cover committed WAL
data/source-byte preservation, isolated restore, repeated unique destinations,
malformed/non-account input, foreign keys, corruption, metadata, safe CLI errors,
configuration rejection, port/proxy/volume topology and complete image inputs.
The Windows privilege limitation and Linux deployment need separate verification.
The combined command `node --test server/*.test.mjs server/deploy/deployment.test.mjs`
also passed: 76 tests, 75 passed, 0 failed, the same 1 skipped test. These are
isolated source/integration checks, not a production deployment test.

Before calling a deployment usable, record evidence for:

- Image build and pinned image digests; actual Compose/Caddy validation; writable
  Linux volumes with private ownership; container restart persistence.
- Valid public TLS and DNS, browser registration/linking, secure cookies/CSRF,
  authenticated WSS upgrades, rejection without auth and rejection of forged
  forwarding headers; no secrets in logs.
- Independent Android and Windows users through two-player matchmaking, an entire
  accepted-rule match, bounded reconnect and persisted result after restart.
- External inability to connect to 8080/8081; no access to the database or backup
  files through HTTP; successful encrypted off-host backup/isolated restore drill.
- Operational capacity and abuse/rate-limit checks, backup retention, monitoring,
  maintenance policy, and known unsupported game-rule/content boundaries.

No changes to `custom-bootstrap-server.mjs` are required for this scaffold's
current interface. Future root-level work includes active-match drain/durability,
completed/full-game rule fidelity, account recovery/email-verification policy,
and real staged deployment validation. `npm test` in `server` now includes the
deployment tests alongside `*.test.mjs`; the explicit command above remains useful
for the bounded deployment/backup subset.

## Optional modular client delivery

The image includes the content protocol and read-only release handler. Content
is disabled by default. In a reviewed Compose override, mount the separately
published public release directory read-only and set `DUEL_CONTENT_ROOT` to that
container path. Do not mount account data, backups, private settings or the
configured Windows installation as content. No private release input is bundled
into the image.

The layout is `manifests/windows.json`, `manifests/android.json`, and immutable
`blobs/<sha256>`. Publish blobs before atomically replacing each platform's
manifest. Discovery at `/v1/content/manifest?platform=windows&runtime_abi=godot-4.7.2`
works before account login and rejects unsupported runtime requirements. All
referenced blobs and complete target hashes validate before manifest delivery;
missing/corrupt targets return 503. Blobs are limited to 20,000,000 bytes and
support HEAD, ETag and single HTTP byte ranges. Retain old blobs for clients
whose manifest was fetched before publication. Changes to Node server code or
authoritative masters still require a coordinated server release.
