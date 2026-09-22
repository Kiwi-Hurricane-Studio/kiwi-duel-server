import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ROOM_CONTRACT_VERSION = 2;
export const OWNED_CONTENT_REVISION = 3;
export const ROOM_GATE_NAMES = Object.freeze([
  "FigureList", "UserLibrariesByEvoIdLoad", "PlateList", "DeckList", "TicketList",
  "LoadChapterMasters", "UpdateCampaign", "RefreshUserArena", "RefreshUserArenaEvent",
  "LoadArenaLeagueDetail", "LoadArenaRewardBoxRouletteMasters",
  "GetSwissDrawAndKnockoutStageTheFirstLoading", "LoadUserTutorials", "PreloadUsedScSeAndBootAndAdvSe",
]);
export const PACKAGED_MASTER_URLS = Object.freeze({
  boot_constants: new URL("../assets/authentic/android_data/boot_masters/constants.json", import.meta.url),
  chapter_masters: new URL("../assets/authentic/android_data/boot_masters/chapter_masters.json", import.meta.url),
  arena_league_masters: new URL("../assets/authentic/android_data/boot_masters/arena_league_masters.json", import.meta.url),
  arena_reward_box_masters: new URL("../assets/authentic/android_data/boot_masters/arena_reward_box_masters.json", import.meta.url),
});
const NONE_POLICY = Object.freeze({ schema: 1, campaigns: "none", arena_events: "none", swiss_draw: "none", knockout_stage: "none" });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const positive = (value) => integer(value, 1);
const nullableTime = (value) => value === null || integer(value);

export function requestedReadinessSchema(body) {
  if (!object(body)) throw new Error("readiness_request_object_required");
  if (body.readiness_schema === undefined || body.readiness_schema === 1) return 1;
  if (body.readiness_schema === ROOM_CONTRACT_VERSION) return ROOM_CONTRACT_VERSION;
  throw new Error("unsupported_readiness_schema");
}

export function packagedMasterBinding(bytes = Object.fromEntries(Object.entries(PACKAGED_MASTER_URLS).map(([key, url]) => [key, readFileSync(url)]))) {
  const digests = {};
  for (const key of Object.keys(PACKAGED_MASTER_URLS)) {
    if (!Buffer.isBuffer(bytes[key])) throw new Error(`bootstrap_master_bytes_missing_${key}`);
    let model;
    try { model = JSON.parse(bytes[key].toString("utf8")); } catch { throw new Error(`bootstrap_master_json_invalid_${key}`); }
    const shape = key === "arena_reward_box_masters" ? object(model) : Array.isArray(model);
    if (!shape || Object.keys(model).length === 0) throw new Error(`bootstrap_master_shape_invalid_${key}`);
    digests[key] = createHash("sha256").update(bytes[key]).digest("hex");
  }
  // Hash the preserved bytes, not JSON serialization. The client owns cache
  // normalization/reference checks and may not infer readiness from this hash.
  return { source_revision: 800, content_revision: OWNED_CONTENT_REVISION, digests };
}

export function createBootstrapReadiness({ figureMasters, renderModelIds, plateMasters, masterBytes } = {}) {
  if (!Array.isArray(figureMasters) || figureMasters.length === 0 || !(renderModelIds instanceof Set)) throw new Error("bootstrap_figure_catalog_invalid");
  if (!Array.isArray(plateMasters) || plateMasters.length === 0) throw new Error("bootstrap_plate_catalog_invalid");
  const binding = packagedMasterBinding(masterBytes);
  const figureIds = new Set();
  const catalog = figureMasters.map((master) => {
    if (!object(master) || !integer(master.item_master_id) || !integer(master.model_id) || !integer(master.mp) || figureIds.has(master.item_master_id)) {
      throw new Error("bootstrap_figure_catalog_invalid");
    }
    figureIds.add(master.item_master_id);
    const available = master.item_master_id > 0 && master.model_id > 0 && renderModelIds.has(master.model_id);
    return { ...structuredClone(master), figure_master_id: master.item_master_id, movement_points: master.mp, playable: available, render_available: available };
  });
  const figureMap = new Map(catalog.map((master) => [master.item_master_id, master]));
  const plateMap = new Map();
  for (const master of plateMasters) {
    if (!object(master) || !positive(master.item_master_id) || plateMap.has(master.item_master_id) ||
      !integer(master.cost) || !integer(master.plate_no) || !integer(master.plate_icon) || !integer(master.rarity) ||
      typeof master.name !== "string" || !master.name || typeof master.description !== "string" || !master.description) {
      throw new Error("bootstrap_plate_catalog_invalid");
    }
    plateMap.set(master.item_master_id, structuredClone(master));
  }

  function roomPreload(inputModels, { servicePolicy = NONE_POLICY, ownerUserId } = {}) {
    if (!object(inputModels)) throw new Error("bootstrap_room_models_required");
    if (!positive(ownerUserId)) throw new Error("bootstrap_room_owner_invalid");
    const models = structuredClone(inputModels);
    // Preserve ownership projections but never pretend they are historical
    // encounters/tutorial progress or an implemented ranked-progression model.
    models.figure_libraries = [];
    models.tickets = [];
    models.tutorials = [];
    models.user_arena = { chests: models.user_arena?.chests, active_events: [], progression_supported: false };
    models.service_policy = structuredClone(servicePolicy);
    models.campaigns = [];
    models.swiss_draw = [];
    models.knockout_stages = [];
    const errors = [];
    const steps = {};
    const state = (name, status, authority, reason, required = false) => {
      steps[name] = { state: status, authority, reason, required_for_home: required };
      if (status === "failed") errors.push(reason);
    };
    const unsupported = (name, reason) => state(name, "unsupported", "server", reason);
    const local = (name) => state(name, "pending", "client", "local_validation_required", true);
    const ownedFigures = new Map();
    const instanceIds = new Set();
    let validFigures = Array.isArray(models.figures);
    if (validFigures) for (const figure of models.figures) {
      const master = figureMap.get(figure?.item_master_id);
      if (!object(figure) || !positive(figure.user_figure_id) || instanceIds.has(figure.user_figure_id) ||
        !positive(figure.item_master_id) || !positive(figure.model_id) || !integer(figure.level, 1) ||
        !master?.render_available || master.model_id !== figure.model_id) { validFigures = false; break; }
      instanceIds.add(figure.user_figure_id);
      const key = `${figure.item_master_id}:${figure.model_id}`;
      ownedFigures.set(key, (ownedFigures.get(key) || 0) + 1);
    }
    state("FigureList", validFigures ? (models.figures.length ? "loaded" : "empty") : "failed", "server", validFigures ? "owned_inventory_validated" : "figure_inventory_invalid", true);
    unsupported("UserLibrariesByEvoIdLoad", "collection_history_not_implemented");

    let validPlates = Array.isArray(models.plates) && models.plates.length === plateMap.size;
    const suppliedMasterIds = new Set();
    if (validPlates) for (const master of models.plates) {
      const expected = plateMap.get(master?.item_master_id);
      if (!expected || suppliedMasterIds.has(master.item_master_id) || ["name", "description", "plate_no", "plate_icon", "rarity", "cost"].some((key) => master[key] !== expected[key])) { validPlates = false; break; }
      suppliedMasterIds.add(master.item_master_id);
    }
    const plateQuantities = new Map();
    const plateInstanceIds = new Set();
    validPlates &&= Array.isArray(models.plate_inventory);
    if (validPlates) for (const plate of models.plate_inventory) {
      if (!object(plate) || !positive(plate.user_plate_id) || plateInstanceIds.has(plate.user_plate_id) ||
        !plateMap.has(plate.item_master_id) || plateQuantities.has(plate.item_master_id) || !integer(plate.quantity)) { validPlates = false; break; }
      plateInstanceIds.add(plate.user_plate_id);
      plateQuantities.set(plate.item_master_id, plate.quantity);
    }
    state("PlateList", validPlates ? (models.plate_inventory.length ? "loaded" : "empty") : "failed", "server", validPlates ? "owned_plates_and_catalog_validated" : "plate_inventory_or_catalog_invalid", true);

    let validDecks = validFigures && validPlates && Array.isArray(models.decks) && models.decks.length > 0 && models.decks.length <= 12;
    const deckNumbers = new Set();
    if (validDecks) for (const deck of models.decks) {
      if (!object(deck) || !integer(deck.deck_no, 1, 12) || deckNumbers.has(deck.deck_no) || typeof deck.name !== "string" ||
        !Array.isArray(deck.figures) || deck.figures.length > 6 || !Array.isArray(deck.plates) || deck.plates.length > 6) { validDecks = false; break; }
      deckNumbers.add(deck.deck_no);
      const usedFigures = new Map();
      const usedPlates = new Map();
      for (const [index, figure] of deck.figures.entries()) {
        if (!object(figure) || figure.deck_index !== index || !positive(figure.item_master_id) || !positive(figure.model_id)) { validDecks = false; break; }
        const key = `${figure.item_master_id}:${figure.model_id}`;
        const count = (usedFigures.get(key) || 0) + 1;
        usedFigures.set(key, count);
        if (count > (ownedFigures.get(key) || 0)) { validDecks = false; break; }
      }
      for (const plateId of deck.plates) {
        const count = (usedPlates.get(plateId) || 0) + 1;
        usedPlates.set(plateId, count);
        if (!positive(plateId) || count > (plateQuantities.get(plateId) || 0)) { validDecks = false; break; }
      }
      if (!validDecks) break;
    }
    state("DeckList", validDecks ? "loaded" : "failed", "server", validDecks ? "deck_inventory_joins_validated" : "deck_inventory_join_invalid", true);
    unsupported("TicketList", "ticket_stock_not_implemented");
    local("LoadChapterMasters");

    const policyValid = object(servicePolicy) && servicePolicy.schema === 1;
    const policyGate = (name, keys, reason, suppliedLists) => {
      const values = keys.map((key) => servicePolicy?.[key]);
      if (!policyValid || values.some((value) => !["none", "active"].includes(value))) state(name, "failed", "server", "service_policy_invalid");
      else if (values.some((value) => value === "active")) unsupported(name, "active_mode_not_implemented");
      else if (suppliedLists.some((value) => value !== undefined && (!Array.isArray(value) || value.length !== 0))) state(name, "failed", "server", "service_policy_data_conflict");
      else state(name, "not_applicable", "server", reason);
    };
    policyGate("UpdateCampaign", ["campaigns"], "owned_service_no_campaigns_policy", [inputModels.campaigns]);

    const chestIds = new Set();
    const chestSlots = new Set();
    let validArena = Array.isArray(models.user_arena.chests) && models.user_arena.chests.length <= 3;
    if (validArena) for (const chest of models.user_arena.chests) {
      if (!object(chest) || !positive(chest.chest_id) || chestIds.has(chest.chest_id) || !integer(chest.slot_index, 0, 2) || chestSlots.has(chest.slot_index) ||
        !["locked", "unlocking", "ready"].includes(chest.state) || !nullableTime(chest.unlock_started_at) || !nullableTime(chest.ready_at) ||
        !nullableTime(chest.remaining_milliseconds) || typeof chest.source !== "string" ||
        (chest.state !== "locked" && (chest.unlock_started_at === null || chest.ready_at === null || chest.remaining_milliseconds === null)) ||
        (chest.state === "ready" && chest.remaining_milliseconds !== 0)) { validArena = false; break; }
      chestIds.add(chest.chest_id); chestSlots.add(chest.slot_index);
    }
    // The supported chest projection is real; the original arena progression
    // gate remains unsupported, rather than presenting a fake rank as loaded.
    state("RefreshUserArena", validArena ? "unsupported" : "failed", "server", validArena ? "chests_validated_arena_progression_not_implemented" : "arena_chests_invalid", true);
    policyGate("RefreshUserArenaEvent", ["arena_events"], "owned_service_no_arena_events_policy", [inputModels.user_arena?.active_events]);
    local("LoadArenaLeagueDetail");
    local("LoadArenaRewardBoxRouletteMasters");
    policyGate("GetSwissDrawAndKnockoutStageTheFirstLoading", ["swiss_draw", "knockout_stage"], "owned_service_no_tournaments_policy", [inputModels.swiss_draw, inputModels.knockout_stages]);
    unsupported("LoadUserTutorials", "tutorial_progress_not_implemented");
    local("PreloadUsedScSeAndBootAndAdvSe");
    const policySupported = policyValid && Object.keys(NONE_POLICY).every((key) => servicePolicy[key] === NONE_POLICY[key]);
    const serverValid = validFigures && validPlates && validDecks && validArena && policySupported && errors.length === 0;
    return {
      schema: ROOM_CONTRACT_VERSION, owner_user_id: ownerUserId, master_binding: structuredClone(binding), models,
      readiness: { schema: ROOM_CONTRACT_VERSION, steps, server_data_valid: serverValid, home_playtest_supported: serverValid,
        full_original_ready: false, errors: [...new Set(errors)],
        supported_projections: { arena_chests: validArena, figure_inventory: validFigures, plate_inventory: validPlates, decks: validDecks } },
    };
  }
  return { masterBinding: structuredClone(binding), figureCatalog: () => structuredClone(catalog), roomPreload };
}
