import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { BACKUP_DIRECTORY, validateProductionConfig } from "./production-config.mjs";

process.umask(0o077);
try {
  const config = validateProductionConfig(process.env);
  for (const directory of ["/var/lib/kiwi-duel", BACKUP_DIRECTORY]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("production_volume_directory_invalid");
    await access(directory, constants.R_OK | constants.W_OK);
  }
  try {
    const database = await lstat(config.database);
    if (!database.isFile() || database.isSymbolicLink()) throw new Error("production_database_file_invalid");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // First registration boot may create the database in the verified volume.
  }
  console.log(JSON.stringify({ event: "production_config_validated", ...config }));
} catch {
  // Configuration can carry secrets in other deployment environments. Do not
  // echo environment values or low-level errors into public shared logs.
  console.error("production_configuration_invalid: run deployment tests and check the deployment README");
  process.exit(1);
}
await import("../custom-bootstrap-server.mjs");
