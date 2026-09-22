import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBootstrapReadiness, packagedMasterBinding, PACKAGED_MASTER_URLS, requestedReadinessSchema, ROOM_GATE_NAMES } from "./bootstrap-readiness.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const sources = {
  figureMasters: Object.values(read("../data/figure_master_map.json").figures),
  renderModelIds: new Set(Object.keys(read("../data/figure_catalog.json").figures).map(Number)),
  plateMasters: read("../data/reference_match_plate_contract.json").plate_masters,
};
const rawService = createBootstrapReadiness(sources);
const service = { ...rawService, roomPreload: (models, options = {}) => rawService.roomPreload(models, { ownerUserId: 1, ...options }) };
function model() {
  const figure = service.figureCatalog().find((entry) => entry.render_available);
  const plate = sources.plateMasters[0];
  return {
    figures: [{ user_figure_id: 1, item_master_id: figure.item_master_id, model_id: figure.model_id, level: 1 }],
    figure_libraries: [{ invented: true }], plates: structuredClone(sources.plateMasters),
    plate_inventory: [{ user_plate_id: 1, item_master_id: plate.item_master_id, quantity: 2 }],
    decks: [{ deck_no: 1, name: "Owned case", figures: [{ deck_index: 0, item_master_id: figure.item_master_id, model_id: figure.model_id }], plates: [plate.item_master_id, plate.item_master_id] }],
    user_arena: { beginner: true, active_events: [], chests: [{ chest_id: 1, slot_index: 0, state: "locked", unlock_started_at: null, ready_at: null, remaining_milliseconds: null, source: "starter" }] },
    chapters: [], arena_leagues: [], arena_rewards: {}, tutorials: [], tickets: [],
  };
}

test("negotiation preserves only absent/explicit v1; malformed/future schemas cannot downgrade", () => {
  assert.equal(requestedReadinessSchema({}), 1);
  assert.equal(requestedReadinessSchema({ readiness_schema: 1 }), 1);
  assert.equal(requestedReadinessSchema({ readiness_schema: 2 }), 2);
  for (const readiness_schema of [null, false, "2", 0, 3, [], {}]) assert.throws(() => requestedReadinessSchema({ readiness_schema }), /unsupported_readiness_schema/);
  assert.throws(() => requestedReadinessSchema([]), /object_required/);
});

test("binding hashes all exact preserved bytes and has an independent owned revision", () => {
  const binding = packagedMasterBinding();
  assert.equal(binding.source_revision, 800);
  assert.equal(binding.content_revision, 3);
  assert.deepEqual(Object.keys(binding.digests).sort(), Object.keys(PACKAGED_MASTER_URLS).sort());
  for (const [key, path] of Object.entries(PACKAGED_MASTER_URLS)) assert.equal(binding.digests[key], createHash("sha256").update(readFileSync(path)).digest("hex"));
  const bytes = Object.fromEntries(Object.entries(PACKAGED_MASTER_URLS).map(([key, path]) => [key, readFileSync(path)]));
  const changed = { ...bytes, boot_constants: Buffer.concat([bytes.boot_constants, Buffer.from("\n")]) };
  assert.notEqual(packagedMasterBinding(changed).digests.boot_constants, binding.digests.boot_constants);
  for (const invalid of [undefined, Buffer.from("null"), Buffer.from("{}"), Buffer.from("[]"), Buffer.from("broken")]) assert.throws(() => packagedMasterBinding({ ...bytes, boot_constants: invalid }), /bootstrap_master_/);
});

test("full figure catalog preserves sentinel/unavailable data without inventing renderability", () => {
  const catalog = service.figureCatalog();
  assert.equal(catalog.length, 583);
  assert.equal(catalog.find((entry) => entry.item_master_id === 0).playable, false);
  assert.equal(catalog.find((entry) => entry.item_master_id === 11002).render_available, false);
  assert.ok(catalog.some((entry) => entry.playable && entry.item_name && entry.movement_points === entry.mp));
  catalog[0].playable = true;
  assert.equal(service.figureCatalog()[0].playable, false);
});

test("all14 truthful outcomes separate supported playtest data from full original fidelity", () => {
  const input = model(); const before = structuredClone(input);
  const room = service.roomPreload(input);
  assert.deepEqual(input, before);
  assert.equal(room.schema, 2);
  assert.equal(room.owner_user_id, 1);
  assert.equal(room.steps, undefined);
  assert.deepEqual(Object.keys(room.readiness.steps).sort(), [...ROOM_GATE_NAMES].sort());
  assert.equal(room.readiness.server_data_valid, true);
  assert.equal(room.readiness.home_playtest_supported, true);
  assert.equal(room.readiness.full_original_ready, false);
  assert.deepEqual(room.readiness.errors, []);
  for (const key of ["LoadChapterMasters", "LoadArenaLeagueDetail", "LoadArenaRewardBoxRouletteMasters", "PreloadUsedScSeAndBootAndAdvSe"]) {
    assert.equal(room.readiness.steps[key].state, "pending"); assert.equal(room.readiness.steps[key].authority, "client");
  }
  for (const key of ["UserLibrariesByEvoIdLoad", "TicketList", "LoadUserTutorials", "RefreshUserArena"]) assert.equal(room.readiness.steps[key].state, "unsupported");
  assert.deepEqual(room.models.figure_libraries, []);
  assert.equal(room.models.user_arena.beginner, undefined);
  assert.equal(room.models.user_arena.progression_supported, false);
  assert.equal(room.readiness.supported_projections.arena_chests, true);
});

test("Room ownership requires the server-authenticated positive account identity", () => {
  assert.throws(() => rawService.roomPreload(model()), /bootstrap_room_owner_invalid/);
  for (const ownerUserId of [0, -1, "1", null, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => rawService.roomPreload(model(), { ownerUserId }), /bootstrap_room_owner_invalid/);
  }
  assert.equal(rawService.roomPreload(model(), { ownerUserId: 91 }).owner_user_id, 91);
});

test("empty authoritative inventory and unused cases are valid browsing data, never tutorial completion", () => {
  const input = model(); input.figures = []; input.plate_inventory = [];
  input.decks[0].figures = []; input.decks[0].plates = []; input.user_arena.chests = [];
  const ready = service.roomPreload(input).readiness;
  assert.equal(ready.server_data_valid, true);
  assert.equal(ready.steps.FigureList.state, "empty");
  assert.equal(ready.steps.PlateList.state, "empty");
  assert.equal(ready.steps.LoadUserTutorials.state, "unsupported");
  assert.equal(ready.full_original_ready, false);
});

test("invalid figure, plate, deck or chest projections cannot claim supported readiness", () => {
  const cases = [
    ["FigureList", (m) => { m.figures = {}; }],
    ["FigureList", (m) => { m.figures.push({ ...m.figures[0] }); }],
    ["FigureList", (m) => { m.figures[0].model_id = 11002; m.figures[0].item_master_id = 11002; }],
    ["FigureList", (m) => { m.figures[0].level = "1"; }],
    ["PlateList", (m) => { m.plates[0].description = ""; }],
    ["PlateList", (m) => { m.plates.pop(); }],
    ["PlateList", (m) => { m.plate_inventory[0].quantity = -1; }],
    ["PlateList", (m) => { m.plate_inventory.push({ ...m.plate_inventory[0], user_plate_id: 2 }); }],
    ["DeckList", (m) => { m.decks = []; }],
    ["DeckList", (m) => { m.decks[0].figures[0].deck_index = 1; }],
    ["DeckList", (m) => { m.decks[0].figures.push({ ...m.decks[0].figures[0], deck_index: 1 }); }],
    ["DeckList", (m) => { m.decks[0].plates.push(m.decks[0].plates[0]); }],
    ["DeckList", (m) => { m.decks.push({ ...m.decks[0] }); }],
    ["RefreshUserArena", (m) => { m.user_arena.chests[0].state = "claimed"; }],
    ["RefreshUserArena", (m) => { m.user_arena.chests[0].state = "ready"; }],
    ["RefreshUserArena", (m) => { m.user_arena.chests.push({ ...m.user_arena.chests[0], chest_id: 2 }); }],
  ];
  for (const [gate, mutate] of cases) {
    const input = model(); mutate(input);
    const result = service.roomPreload(input).readiness;
    assert.equal(result.steps[gate].state, "failed", gate);
    assert.equal(result.server_data_valid, false, gate);
    assert.equal(result.home_playtest_supported, false, gate);
    assert.ok(result.errors.length > 0, gate);
  }
});

test("no-event/campaign/tournament outcomes require explicit supported policy, active modes remain unsupported", () => {
  const policy = { schema: 1, campaigns: "none", arena_events: "none", swiss_draw: "none", knockout_stage: "none" };
  for (const [key, gate] of [["campaigns", "UpdateCampaign"], ["arena_events", "RefreshUserArenaEvent"], ["swiss_draw", "GetSwissDrawAndKnockoutStageTheFirstLoading"], ["knockout_stage", "GetSwissDrawAndKnockoutStageTheFirstLoading"]]) {
    const active = service.roomPreload(model(), { servicePolicy: { ...policy, [key]: "active" } }).readiness;
    assert.equal(active.steps[gate].state, "unsupported"); assert.equal(active.home_playtest_supported, false);
    const invalid = service.roomPreload(model(), { servicePolicy: { ...policy, [key]: null } }).readiness;
    assert.equal(invalid.steps[gate].state, "failed"); assert.equal(invalid.server_data_valid, false);
  }
  assert.equal(service.roomPreload(model(), { servicePolicy: {} }).readiness.server_data_valid, false);
  const conflicting = model(); conflicting.user_arena.active_events = [{}];
  const result = service.roomPreload(conflicting).readiness;
  assert.equal(result.steps.RefreshUserArenaEvent.state, "failed");
  assert.equal(result.server_data_valid, false);
});

test("malformed packaged catalogs reject startup before account persistence/listeners are imported", () => {
  assert.throws(() => createBootstrapReadiness({ ...sources, figureMasters: [...sources.figureMasters, sources.figureMasters[0]] }), /figure_catalog_invalid/);
  const badPlates = structuredClone(sources.plateMasters); badPlates[0].description = "";
  assert.throws(() => createBootstrapReadiness({ ...sources, plateMasters: badPlates }), /plate_catalog_invalid/);
});
