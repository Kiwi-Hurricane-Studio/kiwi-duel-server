import { isIP } from "node:net";

export const DATABASE_PATH = "/var/lib/kiwi-duel/kiwi-duel.sqlite";
export const BACKUP_DIRECTORY = "/var/backups/kiwi-duel";

// This intentionally validates the fixed single-host Compose topology, not an
// arbitrary reverse-proxy deployment. Failure happens before opening SQLite.
export function validateProductionConfig(env, nodeVersion = process.versions.node) {
  const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
  requireValue(/^24\./.test(nodeVersion), "production_node_24_required");
  requireValue(env.NODE_ENV === "production", "production_mode_required");
  const host = env.DUEL_PUBLIC_HOST || "";
  requireValue(host.length <= 253 && host === host.toLowerCase() && !isIP(host)
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
    && !/(^|\.)(localhost|local|invalid|test|example)$/.test(host)
    && !/(^|\.)example\.(com|net|org)$/.test(host), "production_public_hostname_required");
  requireValue(env.DUEL_SERVER_PUBLIC_BASE === `https://${host}`, "production_https_origin_required");
  requireValue(env.DUEL_SERVER_HOST === "127.0.0.1" && env.DUEL_SERVER_PORT === "8080", "production_http_loopback_required");
  requireValue(env.DUEL_GAME_SERVER_HOST === "127.0.0.1" && env.DUEL_GAME_SERVER_PORT === "8081", "production_tcp_loopback_required");
  requireValue(env.DUEL_GAME_SERVER_PUBLIC_HOST === host, "production_game_hostname_required");
  requireValue(env.DUEL_ACCOUNT_DATABASE === DATABASE_PATH, "production_persistent_database_required");
  requireValue(env.DUEL_BACKUP_DIRECTORY === BACKUP_DIRECTORY, "production_backup_directory_required");
  requireValue(env.DUEL_TRUSTED_PROXY_ADDRESSES === "127.0.0.1,::1,::ffff:127.0.0.1", "production_proxy_allowlist_required");
  requireValue(env.DUEL_DEFAULT_MATCH_MODE === "human", "production_human_matchmaking_required");
  requireValue(!env.DUEL_SEED_ACCOUNTS_PATH, "production_seed_accounts_forbidden");
  requireValue((env.DUEL_GAME_BATTLE_EVIDENCE_MODE || "off") === "off"
    && (env.DUEL_GAME_OPPONENT_PLATE_MODE || "off") === "off", "production_evidence_mode_forbidden");
  requireValue(/^\d+$/.test(env.DUEL_CHEST_UNLOCK_MS || "")
    && Number(env.DUEL_CHEST_UNLOCK_MS) >= 1000
    && Number(env.DUEL_CHEST_UNLOCK_MS) <= 604800000, "production_explicit_chest_policy_required");
  return { public_origin: env.DUEL_SERVER_PUBLIC_BASE, database: DATABASE_PATH,
    http_port: 8080, private_game_port: 8081, match_mode: "human" };
}
