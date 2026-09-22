import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyPlateDeclaration, availablePlateCopy, completePlateTurn, completePlateBattle, createPlateState,
  equippedPlateBinding, plateConditionsSnapshot, replayPlateDeclarations,
} from "./plate-state.mjs";
import { CustomMatchService, customMatchTestHooks } from "./custom-match-engine.mjs";

const archive = new URL("../docs/generated/", import.meta.url);
function native(path) { return JSON.parse(readFileSync(new URL(path, archive), "utf8")).status; }
function fromNative(status) {
  return { id: "isolated-native-plate-fixture", all_moves: [], players: status.plate_conditions.map(({ color, plates }) => ({ color, plates: plates.map(({ id }) => id) })) };
}
function declare(side, id, value) { return { selective_side: side, value: { type: "declare_plate", plate_id: id, value } }; }
const opening = declare("black", 5026, { type: "spot_move", from: 28, to: 16 });
const slot = (state, side, index) => state.plate_conditions.find(({ color }) => color === side).plates[index];

function verifiedQuery(directory, label, operation) {
  const root = new URL(`${directory}/`, archive);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.source_unchanged, true);
  const query = manifest.queries.find((entry) => entry.label === label && entry.operation === operation);
  assert.equal(query.exit_code, 0);
  const request = readFileSync(new URL(query.request_file, root));
  const response = readFileSync(new URL(query.response_file, root));
  assert.equal(createHash("sha256").update(request).digest("hex"), query.request_sha256);
  assert.equal(createHash("sha256").update(response).digest("hex"), query.response_sha256);
  return { request: JSON.parse(request), response: JSON.parse(response) };
}

test("native Long Throw consumes only one ordered duplicate equipped copy", () => {
  const expected = native("battle-route-20260905/plate-engine/turn-000-after-long-throw-status.json");
  const state = createPlateState(fromNative(expected));
  assert.equal(availablePlateCopy(state, "black", 5026), 2);
  assert.deepEqual(applyPlateDeclaration(state, opening, 0), { side: "black", slot: 2, plate_id: 5026 });
  assert.deepEqual(plateConditionsSnapshot(state), expected.plate_conditions);
  assert.equal(availablePlateCopy(state, "black", 5026), 3);
  assert.equal(state.attachments.length, 0);
  applyPlateDeclaration(state, opening, 0);
  assert.equal(availablePlateCopy(state, "black", 5026), 3, "replaying exact index is not another copy use");
  assert.throws(() => applyPlateDeclaration(state, { ...opening, display_info: "different" }, 0), /prefix_conflict/);
  applyPlateDeclaration(state, declare("black", 5026, { type: "spot_move", from: 29, to: 17 }), 4);
  assert.equal(availablePlateCopy(state, "black", 5026), -1);
  assert.equal(availablePlateCopy(state, "white", 5026), 4);
  assert.equal(state.declarations.length, 2);
});

test("native sorted status rows map duplicate occurrences to unsorted authored equipment slots", () => {
  const expected = native("battle-route-20260905/plate-engine/turn-000-after-long-throw-status.json");
  const record = fromNative(expected);
  record.players[0].plates = [5306, 5026, 5022, 5426, 5026, 5023];
  const state = createPlateState(record);
  assert.deepEqual(applyPlateDeclaration(state, opening, 0), { side: "black", slot: 1, plate_id: 5026 });
  assert.deepEqual(plateConditionsSnapshot(state), expected.plate_conditions);
  assert.equal(availablePlateCopy(state, "black", 5026), 4);
  const identity = applyPlateDeclaration(state, declare("black", 5022, { type: "select_pokemon", pokemon: 0 }), 2);
  assert.equal(identity.slot, 2);
  assert.equal(plateConditionsSnapshot(state)[0].plates[0].condition, "active");
  assert.equal(state.attachments[0].slot, 2, "attachment retains equipped slot, not sorted native row zero");
});

for (const [id, path, value, expectedState] of [
  [5022, "turn-000-after-x-attack", { type: "select_pokemon", pokemon: 0 }, "active"],
  [5426, "turn-000-after-air-balloon", { type: "select_pokemon_and_declare_aura", pokemon: 0 }, "aura"],
  [5023, "turn-002-after-pokemon-switch", { type: "swap_move", pokemons: [0, 1] }, "used"],
  [5306, "turn-002-after-goal-block", { type: "spot_move", from: 27, to: 24 }, "used"],
]) {
  test(`native ${id} declaration uses its independent ${expectedState} condition`, () => {
    const expected = native(`battle-route-20260905/plate-engine/${path}-status.json`);
    const state = createPlateState(fromNative(expected));
    const identity = applyPlateDeclaration(state, declare("black", id, value), 2);
    assert.deepEqual(state.plate_conditions, expected.plate_conditions);
    assert.equal(slot(state, "black", identity.slot).condition, expectedState);
    for (const attachment of state.attachments) {
      const effect = expected.pokemon_conditions.find((entry) => entry.pokemon_index === attachment.pokemon)?.effect;
      assert.ok(effect, "native figure effect exists");
      for (const [key, entry] of Object.entries(attachment.effect)) {
        if (key === "ids") assert.deepEqual(effect.ids.plates, entry.plates);
        else assert.deepEqual(effect[key], entry);
      }
    }
  });
}

test("native Full Heal is used while figure continuation remains a separate choice", () => {
  const expected = native("battle-route-20260909/full-heal-native-query/after-full-heal-status.json");
  const state = createPlateState(fromNative(expected));
  applyPlateDeclaration(state, declare("white", 5002, { type: "put_circle", condition: "normal", pokemons: [6] }), 0);
  assert.equal(slot(state, "white", 0).condition, "used");
  assert.equal(slot(state, "white", 0).condition, expected.plate_conditions[1].plates[0].condition);
  assert.deepEqual(state.attachments, []);
  assert.equal(expected.turn, "white", "native does not end this turn merely because the copy became used");
});

test("native Double Chance stays active through first spin and declared respin, then is used", () => {
  const expected = native("battle-route-20260908/double-chance-native-query/after-double-chance-status.json");
  const state = createPlateState(fromNative(expected));
  applyPlateDeclaration(state, declare("white", 5015, { type: "select_pokemon", pokemon: 6 }), 2);
  // The adjacent route is a separate branch with no opening Long Throw.
  for (const name of ["double-chance-then-adjacent", "double-chance-adjacent-declare", "after-double-chance-adjacent-miss", "after-declare-respin"]) {
    const witness = native(`battle-route-20260908/double-chance-native-query/${name}-status.json`);
    assert.deepEqual(state.plate_conditions, witness.plate_conditions, name);
  }
  assert.deepEqual(state.attachments, [{ side: "white", slot: 1, plate_id: 5015, pokemon: 6, effect: { plate_id: [5015] } }]);
  completePlateTurn(state, "white");
  assert.deepEqual(state.plate_conditions, native("battle-route-20260908/double-chance-native-query/after-second-spin-status.json").plate_conditions);
  assert.deepEqual(state.attachments, []);
});

test("Air Balloon unknown lifetime boundary remains visible while proven X Attack expires", () => {
  const record = fromNative(native("battle-route-20260905/plate-engine/turn-000-after-x-attack-status.json"));
  const state = createPlateState(record);
  applyPlateDeclaration(state, declare("black", 5022, { type: "select_pokemon", pokemon: 0 }), 0);
  applyPlateDeclaration(state, declare("black", 5426, { type: "select_pokemon_and_declare_aura", pokemon: 1 }), 1);
  completePlateTurn(state, "black");
  completePlateTurn(state, "black");
  assert.deepEqual(state.unresolved_transitions.map(({ plate_id }) => plate_id), [5426]);
  assert.equal(slot(state, "black", 0).condition, "used");
  assert.equal(slot(state, "black", 5).condition, "aura");
  assert.equal(state.attachments.length, 1);
});

for (const branch of ["pass", "move"]) {
  test(`fresh native X Attack ${branch} turn-end consumes its copy and clears damage/attachment`, async () => {
    const root = new URL("plate-copy-state-20260910/native-matrix-utf8/", archive);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    assert.equal(manifest.source_unchanged, true);
    const witnesses = [];
    for (const stage of [0, 1]) {
      const label = `5022-${branch}-${stage}`;
      const query = manifest.queries.find((entry) => entry.label === label && entry.operation === "status");
      assert.equal(query.exit_code, 0);
      const request = readFileSync(new URL(query.request_file, root));
      const response = readFileSync(new URL(query.response_file, root));
      assert.equal(createHash("sha256").update(request).digest("hex"), query.request_sha256);
      assert.equal(createHash("sha256").update(response).digest("hex"), query.response_sha256);
      witnesses.push({ record: JSON.parse(request).record, status: JSON.parse(response).status });
    }
    const service = new CustomMatchService({ port: 0, opponentTurnDelayMs: 0 });
    service.playOpponentTurn = () => {};
    const match = service.createMatch(`isolated-native-x-attack-${branch}`);
    for (const player of match.record.players) {
      player.plates = [...witnesses[0].record.players.find((entry) => entry.color === player.color).plates];
    }
    match.phase = "started";
    match.socket = { destroyed: false, write: () => {} };
    service.acceptPlayerMove(match, witnesses[0].record.all_moves[0], "black");
    assert.deepEqual(customMatchTestHooks.plateStateSnapshot(match).plate_conditions, witnesses[0].status.plate_conditions);
    assert.equal(match.damageBonuses.get(0), witnesses[0].status.pokemon_conditions[0].effect.damage_plus);
    service.acceptPlayerMove(match, witnesses[1].record.all_moves[1], "black");
    const snapshot = customMatchTestHooks.plateStateSnapshot(match);
    assert.deepEqual(snapshot.plate_conditions, witnesses[1].status.plate_conditions);
    assert.equal(match.turn, witnesses[1].status.turn);
    assert.equal(match.positions.get(0), witnesses[1].status.pokemon_conditions[0].index);
    assert.equal(match.damageBonuses.has(0), false);
    assert.equal(witnesses[1].status.pokemon_conditions[0].effect.damage_plus, undefined);
    assert.deepEqual(snapshot.attachments, []);
    assert.deepEqual(snapshot.diagnostics.unresolved_transitions, []);
    match.phase = "finished";
    await Promise.resolve();
  });
  test(`fresh native Air Balloon ${branch} retains its aura across the activation turn`, () => {
    const root = new URL("plate-copy-state-20260910/native-matrix-utf8/", archive);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
    const query = manifest.queries.find((entry) => entry.label === `5426-${branch}-1` && entry.operation === "status");
    assert.equal(query.exit_code, 0);
    const request = readFileSync(new URL(query.request_file, root));
    const response = readFileSync(new URL(query.response_file, root));
    assert.equal(createHash("sha256").update(request).digest("hex"), query.request_sha256);
    assert.equal(createHash("sha256").update(response).digest("hex"), query.response_sha256);
    const record = JSON.parse(request).record;
    const expected = JSON.parse(response).status;
    const state = createPlateState(record);
    applyPlateDeclaration(state, record.all_moves[0], 0);
    completePlateTurn(state, "black");
    assert.deepEqual(plateConditionsSnapshot(state), expected.plate_conditions);
    assert.equal(expected.turn, "white");
    assert.equal(state.attachments.length, 1);
    assert.equal(state.attachments[0].effect.charge_effect, expected.pokemon_conditions[0].effect.charge_effect);
    assert.deepEqual(state.attachments[0].effect.ids.plates, expected.pokemon_conditions[0].effect.ids.plates);
  });
}

for (const [branch, lastStage] of [["pass", 4], ["move", 3]]) {
  test(`fresh native Air Balloon ${branch} preserves per-copy aura over successive complete turns`, async () => {
    const directory = "plate-copy-state-20260910/native-matrix-air-turns";
    const initial = verifiedQuery(directory, `5426-${branch}-0`, "status");
    const service = new CustomMatchService({ port: 0, opponentTurnDelayMs: 0 });
    service.playOpponentTurn = () => {};
    const match = service.createMatch(`isolated-native-air-turns-${branch}`);
    for (const player of match.record.players) {
      player.plates = [...initial.request.record.players.find((entry) => entry.color === player.color).plates];
    }
    match.phase = "started";
    match.socket = { destroyed: false, write: () => {} };
    for (let stage = 0; stage <= lastStage; stage += 1) {
      const { request, response } = verifiedQuery(directory, `5426-${branch}-${stage}`, "status");
      const action = request.record.all_moves.at(-1);
      service.acceptPlayerMove(match, action, action.selective_side);
      assert.equal(match.turn, response.status.turn);
      assert.deepEqual(customMatchTestHooks.plateStateSnapshot(match).plate_conditions, response.status.plate_conditions);
      assert.deepEqual([...match.positions.entries()], response.status.pokemon_conditions.map((entry) => [entry.pokemon_index, entry.index]));
      const legal = verifiedQuery(directory, `5426-${branch}-${stage}`, "legal_moves").response.legal_moves;
      if (match.turn === "black" && !match.pendingBattles.length) {
        const source = match.positions.get(0);
        const expected = legal.filter((entry) => entry.value.type === "mp_move" && entry.value.route[0] === source).map((entry) => entry.value.route.join(",")).sort();
        const actual = customMatchTestHooks.legalRoutes(match, "black", { allowedPokemon: 0 }).map((entry) => entry.value.route.join(",")).sort();
        assert.deepEqual(actual, expected);
      }
    }
    assert.equal(match.pendingPlate, null, "later-turn movement is not the activation transaction");
    assert.equal(customMatchTestHooks.plateStateSnapshot(match).attachments[0].plate_id, 5426);
    if (branch === "move") assert.equal(match.pendingBattles.length, 1, "adjacent landing remains a battle/null choice, not an automatic turn end");
    match.phase = "finished";
    await Promise.resolve();
  });
}

for (const role of ["attacker", "defender"]) {
  test(`fresh native Air Balloon ${role} is consumed by resolved battle without any knockout`, async () => {
    const directory = "plate-copy-state-20260910/native-air-balloon-battle";
    const before = verifiedQuery(directory, `${role}-declare-battle`, "status");
    const after = verifiedQuery(directory, `${role}-native-spin`, "status");
    const output = verifiedQuery(directory, `${role}-native-spin`, "output_effects").response.effect_moves;
    const selectedPokemon = role === "attacker" ? 6 : 0;
    const disableIndex = output.findIndex((entry) => entry.value.type === "disable_plate_for_one_pokemon");
    assert.deepEqual(output[disableIndex].value, { plate_id: [5426], pokemon: selectedPokemon, type: "disable_plate_for_one_pokemon" });
    assert.equal(output[disableIndex + 1].value.type, "turn_end");
    const nativeSpin = after.request.record.all_moves.at(-1);
    const units = [6, 0].map((pokemon) => nativeSpin.value.spins.find((entry) => entry.pokemon === pokemon).results[0].num);
    const service = new CustomMatchService({ port: 0, opponentTurnDelayMs: 0, spinUnitSource: () => units.shift() });
    service.playOpponentTurn = () => {};
    // Synchronously control the async presentation boundary; call the real spin
    // implementation once the original declare_battle has been accepted.
    service.resolveBattle = () => {};
    const match = service.createMatch(`isolated-native-air-battle-${role}`);
    for (const player of match.record.players) {
      const original = before.request.record.players.find((entry) => entry.color === player.color);
      player.plates = [...original.plates];
      player.pokemons = structuredClone(original.pokemons);
    }
    match.phase = "started";
    match.socket = { destroyed: false, write: () => {} };
    for (const move of before.request.record.all_moves) service.acceptPlayerMove(match, move, move.selective_side);
    assert.deepEqual(customMatchTestHooks.plateStateSnapshot(match).plate_conditions, before.response.status.plate_conditions);
    assert.equal(customMatchTestHooks.plateStateSnapshot(match).attachments[0].pokemon, selectedPokemon);
    service.performBattleSpin(match, 6, 0, "white");
    const snapshot = customMatchTestHooks.plateStateSnapshot(match);
    assert.deepEqual(snapshot.plate_conditions, after.response.status.plate_conditions);
    assert.deepEqual(snapshot.attachments, []);
    assert.deepEqual(snapshot.diagnostics.unresolved_transitions, []);
    assert.equal(match.turn, after.response.status.turn);
    assert.deepEqual([...match.positions.entries()], after.response.status.pokemon_conditions.map((entry) => [entry.pokemon_index, entry.index]));
    assert.deepEqual([match.positions.get(0), match.positions.get(6)], [15, 11], "neither figure enters PC; removal is not a knockout side effect");
    assert.equal(match.conditions.get(0), "paralyze", "unrelated Pokepower outcome is retained");
    assert.equal(match.waits.get(0), 2);
    assert.equal(units.length, 0);
    match.phase = "finished";
    await Promise.resolve();
  });
}

test("battle cleanup removes only participating Air Balloon copies, not another aura or unrelated effect", () => {
  const state = createPlateState({ players: [{ color: "black", plates: [5426, 5426, 5022] }, { color: "white", plates: [5426] }] });
  applyPlateDeclaration(state, declare("black", 5426, { type: "select_pokemon_and_declare_aura", pokemon: 0 }), 0);
  applyPlateDeclaration(state, declare("black", 5426, { type: "select_pokemon_and_declare_aura", pokemon: 1 }), 1);
  applyPlateDeclaration(state, declare("black", 5022, { type: "select_pokemon", pokemon: 0 }), 2);
  const unrelated = structuredClone(state.attachments.slice(1));
  const removed = completePlateBattle(state, [0, 6]);
  assert.deepEqual(removed.map(({ side, slot }) => ({ side, slot })), [{ side: "black", slot: 0 }]);
  assert.deepEqual(state.attachments, unrelated);
  assert.deepEqual(state.plate_conditions[0].plates.map(({ condition }) => condition), ["used", "aura", "active"]);
  assert.deepEqual(completePlateBattle(state, [0, 6]), [], "repeat completion does not consume another copy");
});

test("fresh native MP1 Air Balloon gets additive +1 and two-step routes on its next turn", async () => {
  const directory = "plate-copy-state-20260910/native-air-balloon-mp-one";
  const before = verifiedQuery(directory, "mp-one-before-attach", "status");
  const authored = before.request.record.players[0].pokemons.find((entry) => entry.pokemon_index === 2);
  assert.equal(authored.id, 1244);
  assert.equal(authored.mp, 1);
  assert.equal(before.response.status.pokemon_conditions.find((entry) => entry.pokemon_index === 2).effect.mp, -1, "initial -1 belongs to first-turn penalty, not any plate");
  const service = new CustomMatchService({ port: 0, opponentTurnDelayMs: 0 });
  service.playOpponentTurn = () => {};
  const match = service.createMatch("isolated-native-air-mp-one");
  for (const player of match.record.players) {
    const original = before.request.record.players.find((entry) => entry.color === player.color);
    player.plates = [...original.plates];
    player.pokemons = structuredClone(original.pokemons);
  }
  match.phase = "started";
  match.socket = { destroyed: false, write: () => {} };
  for (const label of ["mp-one-attach", "mp-one-native-pass", "mp-one-white-route"]) {
    const { request, response } = verifiedQuery(directory, label, "status");
    const move = request.record.all_moves.at(-1);
    service.acceptPlayerMove(match, move, move.selective_side);
    const snapshot = customMatchTestHooks.plateStateSnapshot(match);
    assert.equal(snapshot.attachments[0].effect.mp, 1);
    assert.equal(snapshot.attachments[0].effect.mp, response.status.pokemon_conditions.find((entry) => entry.pokemon_index === 2).effect.mp);
    assert.deepEqual(snapshot.plate_conditions, response.status.plate_conditions);
    assert.equal(match.turn, response.status.turn);
  }
  assert.equal(match.pendingPlate, null);
  const expected = verifiedQuery(directory, "mp-one-white-route", "legal_moves").response.legal_moves
    .filter((entry) => entry.value.type === "mp_move" && entry.value.route[0] === 30).map((entry) => entry.value.route.join(",")).sort();
  const actual = customMatchTestHooks.legalRoutes(match, "black", { allowedPokemon: 2 }).map((entry) => entry.value.route.join(",")).sort();
  assert.deepEqual(actual, expected);
  assert.equal(actual.filter((entry) => entry.split(",").length === 3).length, 6);
  completePlateBattle(match.plateState, [2, 6]);
  assert.equal(Math.max(...customMatchTestHooks.legalRoutes(match, "black", { allowedPokemon: 2 }).map((entry) => entry.value.route.length - 1)), 1,
    "detaching returns this figure to authored MP1, not a global MP2 override");
  match.phase = "finished";
  await Promise.resolve();
});

test("an unresolved owned Double Chance first spin does not prematurely detach Air Balloon", async () => {
  // Defensive integration boundary, not a native mixed-plate lifetime witness.
  const service = new CustomMatchService({ port: 0, spinUnitSource: () => 0 });
  service.declareOpponentRespin = () => {};
  const match = service.createMatch("isolated-unresolved-respin-air");
  match.turn = "white";
  match.phase = "started";
  match.socket = { destroyed: false, write: () => {} };
  service.appendMove(match, declare("white", 5426, { type: "select_pokemon_and_declare_aura", pokemon: 6 }));
  service.appendMove(match, declare("white", 5015, { type: "select_pokemon", pokemon: 6 }));
  match.pendingPlate = { side: "white", plateId: 5015, pokemon: 6 };
  service.performBattleSpin(match, 6, 0, "white");
  assert.ok(match.pendingRespin);
  const snapshot = customMatchTestHooks.plateStateSnapshot(match);
  assert.equal(snapshot.plate_conditions[1].plates.find(({ id }) => id === 5426).condition, "aura");
  assert.ok(snapshot.attachments.some(({ plate_id, pokemon }) => plate_id === 5426 && pokemon === 6));
  match.phase = "finished";
  await Promise.resolve();
});

test("invalid attachment targets/equipment fail without partial consumption", () => {
  const record = fromNative(native("battle-route-20260905/plate-engine/turn-000-after-x-attack-status.json"));
  const state = createPlateState(record);
  for (const pokemon of [6, -1, 0.5, "0"]) {
    assert.throws(() => applyPlateDeclaration(state, declare("black", 5022, { type: "select_pokemon", pokemon }), 0), /target_invalid/);
    assert.deepEqual(state, createPlateState(record));
  }
  assert.equal(availablePlateCopy(state, "black", 9999), -1);
  record.players[1].color = "black";
  assert.throws(() => equippedPlateBinding(record), /equipment_invalid/);
});

test("bounded declaration replay is idempotent and explicit turn-end consumes Double Chance", () => {
  const record = fromNative(native("battle-route-20260908/double-chance-native-query/after-double-chance-status.json"));
  record.all_moves = [opening, declare("white", 5015, { type: "select_pokemon", pokemon: 6 }), { selective_side: "white", value: { type: "declare_turn_end" } }];
  assert.equal(slot(replayPlateDeclarations(record), "white", 1).condition, "used");
  assert.deepEqual(replayPlateDeclarations(record), replayPlateDeclarations(record));
});

test("engine initialization follows final white equipment and refuses lost resumed state", () => {
  const service = new CustomMatchService({ port: 0 });
  const match = service.createMatch("isolated-copy-test");
  match.record.players[1].plates = [5026, 5026];
  let snapshot = customMatchTestHooks.plateStateSnapshot(match);
  assert.deepEqual(snapshot.equipped[1].plates, [5026, 5026]);
  service.appendMove(match, opening);
  snapshot = customMatchTestHooks.plateStateSnapshot(match);
  const index = snapshot.plate_conditions[0].plates.findIndex(({ id }) => id === 5026);
  assert.equal(snapshot.record_move_count, 1);
  assert.equal(snapshot.match_id, String(match.record.id));
  assert.equal(snapshot.plate_conditions[0].plates[index].condition, "used");
  snapshot.plate_conditions[0].plates[index].condition = "unused";
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).plate_conditions[0].plates[index].condition, "used");
  match.plateState = null;
  assert.throws(() => customMatchTestHooks.plateStateSnapshot(match), /missing_for_record_prefix/);
});

test("engine Full Heal snapshot distinguishes consumed copy, pending selection and authoritative batch prefix", async () => {
  const service = new CustomMatchService({ port: 0 });
  const match = service.createMatch("isolated-full-heal-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.socket = { destroyed: false, write: (line) => writes.push(line) };
  match.conditions.set(6, "sleep");
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", declare("white", 5002, { type: "put_circle", condition: "normal", pokemons: [6] })), false, "Full Heal is field-only");
  match.positions.set(6, 11);
  service.acceptPlayerMove(match, declare("white", 5002, { type: "put_circle", condition: "normal", pokemons: [6] }), "white");
  await Promise.resolve();
  const snapshot = JSON.parse(writes.find((line) => line.includes(" plate_state ")).split(" plate_state ")[1]);
  assert.equal(snapshot.plate_conditions[1].plates.find(({ id }) => id === 5002).condition, "used");
  assert.deepEqual(snapshot.pending_selection, { side: "white", plate_id: 5002, pokemon: 6 });
  assert.equal(snapshot.record_move_count, match.record.all_moves.length);
  assert.equal(match.turn, "white");
  assert.equal(match.conditions.get(6), "normal");
  const before = match.record.all_moves.length;
  let rejection;
  service.rejectPlayerMove = (_match, error) => { rejection = error; };
  service.acceptPlayerMove(match, declare("white", 5015, { type: "select_pokemon", pokemon: 6 }), "white");
  assert.equal(rejection, "plate_continuation_required");
  assert.equal(match.record.all_moves.length, before, "used Full Heal still requires its separate continuation before another plate");
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "unused");
  match.phase = "finished";
});
