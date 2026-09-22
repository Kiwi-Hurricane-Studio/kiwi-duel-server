import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CustomMatchService,
  customMatchContract,
  customMatchTestHooks,
} from "./custom-match-engine.mjs";

const ownedWheelMatrix = JSON.parse(readFileSync(new URL(
  "../docs/generated/battle-route-20260906/custom-engine-authority/controlled-records/owned-route-wheel-matrix.json",
  import.meta.url,
), "utf8"));
const nativeWheelStatusRoot = new URL(
  "../docs/generated/battle-route-20260909/native-owned-wheel-matrix/",
  import.meta.url,
);

test("owned match records sanitize captured identity and preserve authored wheels", () => {
  const record = customMatchTestHooks.makeRecord(7654321);
  assert.equal(record.id, "7654321");
  assert.deepEqual(record.players.map((player) => player.id), ["900000001", "900000002"]);
  assert.deepEqual([record.client_ai_name, record.server_ai_name], ["kiwi-duel-local", "kiwi-duel-opponent"]);
  assert.deepEqual(record.all_moves, []);
  assert.equal(record.players.flatMap((player) => player.pokemons).length, 12);
  assert.deepEqual(
    record.players.flatMap((player) => player.pokemons.map(
      (pokemon) => pokemon.skills.reduce((total, skill) => total + Number(skill.range), 0),
    )),
    Array(12).fill(96),
  );
  assert.deepEqual(customMatchContract.decks.map((deck) => deck.map((entry) => entry.modelId)), [
    [302, 106, 244, 345, 313, 433],
    [414, 25, 296, 150, 388, 103],
  ]);
});

test("base color and damage priority matches the recovered battle tips", () => {
  const winner = customMatchTestHooks.baseSkillWinner;
  const skill = (color, power = 0) => ({ color, speed_or_damage: power });
  assert.equal(winner(skill(0), skill(0)), -1);
  assert.equal(winner(skill(0), skill(1, 10)), 1);
  assert.equal(winner(skill(4), skill(1, 999)), 0);
  assert.equal(winner(skill(4), skill(4)), -1);
  assert.equal(winner(skill(2, 2), skill(1, 999)), 0);
  assert.equal(winner(skill(2, 2), skill(3, 1)), 1);
  assert.equal(winner(skill(2, 3), skill(2, 2)), 0);
  assert.equal(winner(skill(1, 30), skill(3, 60)), 1);
  assert.equal(winner(skill(1, 60), skill(3, 30)), 0);
});

test("first-turn MP penalty belongs to the authored first player, including mirrored white starts", () => {
  const service = new CustomMatchService({ port: 0 });
  const match = service.createMatch("mirrored-first-player-route-rule");
  match.record.first_player = "white";
  match.turn = "white";
  const white = customMatchTestHooks.legalRoutes(match, "white").filter((move) => move.value.route[0] === 34);
  const black = customMatchTestHooks.legalRoutes(match, "black").filter((move) => move.value.route[0] === 28);
  assert.ok(white.length > 0);
  assert.ok(white.every((move) => move.value.route.length <= 2));
  assert.ok(black.some((move) => move.value.route.length === 3));
});

test("Pokepower 1227 retains the native1372 White-to-Gold witness on first battle after field entry", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("speedup-skill-test");
  const pokemon = match.record.players[0].pokemons[0];
  pokemon.pokepower = 1227;
  pokemon.skills[1].id = 1372;
  pokemon.skills[1].color = 1;
  pokemon.skills[1].speed_or_damage = 30;
  match.positions.set(0, 15);
  const selected = customMatchTestHooks.selectedSkill(match, 0, 20);
  assert.equal(selected.id, 1372);
  assert.equal(selected.original_color, 1);
  assert.equal(selected.color, 3);
  assert.equal(selected.speedup_skill, true);

  pokemon.pokepower = 1186;
  const control = customMatchTestHooks.selectedSkill(match, 0, 20);
  assert.equal(control.color, 1);
  assert.equal(control.speedup_skill, undefined);
});

test("battle spin uses each real wheel range and the original wire envelope", () => {
  const units = [15, 20];
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    opponentTurnDelayMs: 0,
    spinUnitSource: (maximum) => {
      assert.equal(maximum, 96);
      return units.shift();
    },
  });
  const match = service.createMatch("test-session");
  const writes = [];
  match.phase = "started";
  match.socket = { destroyed: false, write: (value) => writes.push(value) };
  service.resolveBattle(match, {
    selective_side: "black",
    value: { from_pokemon: 0, to_pokemon: 6, type: "declare_battle" },
  });
  const wire = writes.find((value) => value.includes(" do_move "));
  assert.ok(wire);
  const payload = JSON.parse(wire.slice(wire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.equal(payload.selective_side, "both");
  assert.deepEqual(payload.value.spins, [
    { pokemon: 0, results: [{ displace: 0, num: 15, type: "battle" }] },
    { pokemon: 6, results: [{ displace: 0, num: 20, type: "battle" }] },
  ]);
  match.phase = "finished";
});

test("Double Chance pauses, advertises a native respin, and retains the other wheel", () => {
  const units = [3, 41, 34];
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    spinUnitSource: (maximum) => {
      assert.equal(maximum, 96);
      return units.shift();
    },
  });
  // Keep the decision boundary synchronous and invoke each recovered command
  // explicitly; production uses the same methods through its pacing timers.
  service.declareOpponentRespin = () => {};
  service.performPendingRespin = () => {};
  const match = service.createMatch("double-chance-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.positions.set(6, 12);
  match.positions.set(0, 21);
  service.appendMove(match, { selective_side: "white", value: { type: "declare_plate", plate_id: 5015, value: { type: "select_pokemon", pokemon: 6 } } });
  match.pendingPlate = { side: "white", plateId: 5015, pokemon: 6 };
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  service.performBattleSpin(match, 6, 0, "white");
  const firstSpin = JSON.parse(writes[0].slice(writes[0].indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(firstSpin.value.spins, [
    { pokemon: 0, results: [{ displace: 0, num: 41, type: "battle" }] },
    { pokemon: 6, results: [{ displace: 0, num: 3, type: "battle" }] },
  ]);
  assert.equal(match.turn, "white");
  assert.equal(match.positions.get(6), 12);
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "active");
  assert.deepEqual(match.pendingRespin, {
    side: "white",
    pokemon: 6,
    attacker: 6,
    defender: 0,
    attackingSide: "white",
    turnSide: "white",
    attackerUnit: 3,
    defenderUnit: 41,
    spinRecordIndex: 1,
    evidenceMode: "off",
    declared: false,
  });

  CustomMatchService.prototype.declareOpponentRespin.call(service, match);
  const declaration = JSON.parse(writes[1].slice(writes[1].indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(declaration, {
    display_info: "move",
    selective_side: "white",
    value: { pokemons: [6], type: "declare_respin" },
  });
  CustomMatchService.prototype.performPendingRespin.call(service, match);
  const secondSpin = JSON.parse(writes[2].slice(writes[2].indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(secondSpin.value.spins, [
    { pokemon: 6, results: [{ displace: 0, num: 34, type: "battle" }] },
  ]);
  assert.equal(match.turn, "black");
  assert.equal(match.pendingRespin, null);
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "used");
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).attachments.some(({ plate_id }) => plate_id === 5015), false);
  assert.equal(match.conditions.get(0), "paralyze");
  assert.equal(match.waits.get(0), 2);
  assert.equal(units.length, 0);
  match.phase = "finished";
});

test("declining Double Chance resolves the retained first result", () => {
  const units = [3, 41];
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    spinUnitSource: () => units.shift(),
  });
  service.declareOpponentRespin = () => {};
  const match = service.createMatch("double-chance-decline-test");
  match.phase = "started";
  match.turn = "white";
  match.positions.set(6, 12);
  match.positions.set(0, 21);
  service.appendMove(match, { selective_side: "white", value: { type: "declare_plate", plate_id: 5015, value: { type: "select_pokemon", pokemon: 6 } } });
  match.pendingPlate = { side: "white", plateId: 5015, pokemon: 6 };
  match.socket = { destroyed: false, write: () => {} };
  service.performBattleSpin(match, 6, 0, "white");
  service.finishPendingBattleWithoutRespin(match);
  assert.equal(match.turn, "black");
  assert.equal(match.positions.get(6), 43);
  assert.equal(match.pendingRespin, null);
  assert.equal(customMatchTestHooks.plateStateSnapshot(match).plate_conditions[1].plates.find(({ id }) => id === 5015).condition, "used");
  match.phase = "finished";
});

for (const lateType of ["declare_respin", "null_move"]) {
  test(`training rejects ${lateType} after committing a respin choice`, () => {
    const service = new CustomMatchService({ port: 0, moveDelayMs: 0 });
    const match = service.createMatch("isolated-training-respin-commit-test");
    match.phase = "started";
    match.turn = "black";
    match.socket = { write() {}, destroy() {} };
    match.battleResolutionPending = true;
    match.pendingRespin = { side: "black", pokemon: 0, attacker: 0, defender: 6,
      attackingSide: "black", attackerUnit: 3, defenderUnit: 41, declared: false };
    // Bound this fixture at command acceptance, before the delayed outcome.
    service.pauseMatchClock = () => true;
    service.performPendingRespin = () => {};
    let rejected = "", declined = false;
    service.rejectPlayerMove = (_match, error) => { rejected = error; };
    service.finishPendingBattleWithoutRespin = () => { declined = true; };
    try {
      service.acceptPlayerMove(match, { selective_side: "black", value: { type: "declare_respin", pokemons: [0] } });
      assert.equal(match.pendingRespin.declared, true);
      const count = match.record.all_moves.length;
      service.acceptPlayerMove(match, { selective_side: "black", value: lateType === "declare_respin"
        ? { type: lateType, pokemons: [0] } : { type: lateType } });
      assert.equal(match.record.all_moves.length, count);
      assert.equal(declined, false);
      assert.equal(rejected, "respin_already_declared");
    } finally { match.phase = "finished"; }
  });
}

test("equipped evidence plates are server-validated and X Attack changes battle damage", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("plate-test");
  const xAttack = {
    selective_side: "black",
    value: { plate_id: 5022, type: "declare_plate", value: { pokemon: 0, type: "select_pokemon" } },
  };
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", xAttack), true);
  match.positions.set(0, 41);
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", xAttack), false);
  match.positions.set(0, 28);
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", {
    selective_side: "black",
    value: { plate_id: 9999, type: "declare_plate", value: { pokemon: 0, type: "select_pokemon" } },
  }), false);
  match.damageBonuses.set(0, 30);
  const selected = customMatchTestHooks.selectedSkill(match, 0, 20);
  assert.equal(selected.id, 1452);
  assert.equal(selected.speed_or_damage, 60);

  const longThrow = {
    selective_side: "black",
    value: { plate_id: 5026, type: "declare_plate", value: { from: 28, to: 16, type: "spot_move" } },
  };
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", longThrow), true);
  match.positions.set(0, 41);
  const illegalCenterLongThrow = structuredClone(longThrow);
  illegalCenterLongThrow.value.value.from = 41;
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", illegalCenterLongThrow), false);
  match.positions.set(0, 28);
  const illegalOccupiedLongThrow = structuredClone(longThrow);
  match.positions.set(1, 16);
  assert.equal(customMatchTestHooks.validatePlateMove(match, "black", illegalOccupiedLongThrow), false);

  const fullHeal = {
    selective_side: "white",
    value: {
      plate_id: 5002,
      type: "declare_plate",
      value: { condition: "normal", pokemons: [6], type: "put_circle" },
    },
  };
  match.conditions.set(6, "sleep");
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", fullHeal), false, "Full Heal cannot target the bench");
  match.positions.set(6, 11);
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", fullHeal), true);
  const wrongFullHealTarget = structuredClone(fullHeal);
  wrongFullHealTarget.value.value.pokemons = [0];
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", wrongFullHealTarget), false);
  customMatchTestHooks.applyPositionMove(match, fullHeal);
  assert.equal(match.conditions.get(6), "normal");
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", fullHeal), false);
});

test("controlled opponent Long Throw reproduces the native-observed white 34 to 1 action", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    opponentPlateMode: "native_white_long_throw_once",
  });
  const match = service.createMatch("opponent-plate-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.turns.black = 1;
  match.positions.set(0, 16);
  service.appendMove(match, {
    selective_side: "black",
    value: { plate_id: 5026, type: "declare_plate", value: { from: 28, to: 16, type: "spot_move" } },
  });
  // The live server appends this authoritative turn-start update before the
  // delayed opponent callback evaluates the preceding player plate.
  service.appendMove(match, {
    selective_side: "neither",
    value: { black: 0, black_result: 0, type: "add_z_gauge", white: 3, white_result: 3 },
  });
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  service.playOpponentTurn(match);

  const response = writes.find((value) => value.includes(" do_move "));
  assert.ok(response);
  const move = JSON.parse(response.slice(response.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(move, {
    display_info: "move",
    selective_side: "white",
    value: { plate_id: 5026, type: "declare_plate", value: { from: 34, to: 1, type: "spot_move" } },
  });
  assert.equal(match.positions.get(6), 1);
  assert.equal(match.opponentPlateUsed, true);
  assert.equal(match.turn, "black");
  assert.equal(match.turns.white, 1);
  assert.equal(customMatchTestHooks.validatePlateMove(match, "white", move), false);
});

test("controlled opponent Air Balloon preserves the native two-action white turn", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    moveDelayMs: 0,
    opponentPlateMode: "native_white_air_balloon_once",
  });
  const match = service.createMatch("opponent-air-balloon-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.turns.black = 1;
  match.positions.set(0, 16);
  service.appendMove(match, {
    selective_side: "black",
    value: { plate_id: 5026, type: "declare_plate", value: { from: 28, to: 16, type: "spot_move" } },
  });
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  service.playOpponentTurn(match);

  const plateWire = writes.find((value) => value.includes(" do_move "));
  assert.ok(plateWire);
  const plateMove = JSON.parse(plateWire.slice(plateWire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(plateMove, {
    display_info: "move",
    selective_side: "white",
    value: {
      plate_id: 5426,
      type: "declare_plate",
      value: { pokemon: 6, type: "select_pokemon_and_declare_aura" },
    },
  });
  assert.deepEqual(match.pendingPlate, { side: "white", plateId: 5426, pokemon: 6 });
  assert.equal(match.turn, "white");

  service.playOpponentTurn(match);

  const moveWires = writes.filter(
    (value) => value.includes(" do_move ") && !value.includes('"type":"add_z_gauge"'),
  );
  assert.equal(moveWires.length, 2);
  const movement = JSON.parse(
    moveWires[1].slice(moveWires[1].indexOf(" do_move ") + " do_move ".length).trim(),
  );
  assert.equal(movement.selective_side, "white");
  assert.equal(movement.value.type, "mp_move");
  assert.equal(movement.value.route[0], 34);
  assert.ok(movement.value.route.length <= 3);
  assert.equal(match.pendingPlate, null);
  assert.equal(match.turn, "black");
  assert.equal(match.turns.white, 1);
});

test("controlled opponent Full Heal emits native PutCircle and preserves the white turn", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    opponentPlateMode: "native_white_full_heal_once",
  });
  const match = service.createMatch("opponent-full-heal-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.positions.set(0, 14);
  match.positions.set(6, 10);
  match.conditions.set(6, "sleep");
  match.socket = { destroyed: false, write: (value) => writes.push(value) };
  service.playOpponentTurn = () => {};

  CustomMatchService.prototype.playOpponentTurn.call(service, match);

  const plateWire = writes.find((value) => value.includes(" do_move "));
  assert.ok(plateWire);
  const plateMove = JSON.parse(plateWire.slice(plateWire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(plateMove, {
    display_info: "move",
    selective_side: "white",
    value: {
      plate_id: 5002,
      type: "declare_plate",
      value: { condition: "normal", pokemons: [6], type: "put_circle" },
    },
  });
  assert.equal(match.conditions.get(6), "normal");
  assert.deepEqual(match.pendingPlate, { side: "white", plateId: 5002, pokemon: 6 });
  assert.equal(match.opponentPlateUsed, true);
  assert.equal(match.turn, "white");
  assert.deepEqual(match.pendingBattles, [{
    display_info: "move",
    selective_side: "white",
    value: { from_pokemon: 6, to_pokemon: 0, type: "declare_battle" },
  }]);
});

test("controlled native Blue versus Purple spin produces paralysis and Wait 2", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    battleEvidenceMode: "native_white_blue_1620_paralysis_once",
  });
  const match = service.createMatch("battle-condition-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.positions.set(6, 11);
  match.positions.set(0, 15);
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  service.performBattleSpin(match, 6, 0, "white");

  const spinWire = writes.find((value) => value.includes(" do_move "));
  assert.ok(spinWire);
  const spin = JSON.parse(spinWire.slice(spinWire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(spin.value.spins, [
    { pokemon: 0, results: [{ displace: 0, num: 90, type: "battle" }] },
    { pokemon: 6, results: [{ displace: 0, num: 93, type: "battle" }] },
  ]);
  assert.equal(customMatchTestHooks.selectedSkill(match, 6, 93).id, 1620);
  assert.equal(customMatchTestHooks.selectedSkill(match, 0, 90).id, 1085);
  assert.equal(match.conditions.get(0), "paralyze");
  assert.equal(match.waits.get(0), 2);
  assert.equal(match.positions.get(0), 15);
  assert.equal(match.turn, "black");
  assert.equal(match.battleEvidenceUsed, true);
});

test("controlled native black Purple versus white White spin produces Sleep for Full Heal", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    battleEvidenceMode: "native_black_purple_1085_sleep_white_once",
  });
  const match = service.createMatch("battle-sleep-test");
  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.positions.set(0, 14);
  match.positions.set(6, 10);
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  service.performBattleSpin(match, 6, 0, "white");

  const spinWire = writes.find((value) => value.includes(" do_move "));
  assert.ok(spinWire);
  const spin = JSON.parse(spinWire.slice(spinWire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(spin.value.spins, [
    { pokemon: 0, results: [{ displace: 0, num: 94, type: "battle" }] },
    { pokemon: 6, results: [{ displace: 0, num: 46, type: "battle" }] },
  ]);
  assert.equal(customMatchTestHooks.selectedSkill(match, 0, 94).id, 1085);
  assert.equal(customMatchTestHooks.selectedSkill(match, 6, 46).id, 1621);
  assert.equal(match.conditions.get(6), "sleep");
  assert.equal(match.conditions.get(0), "paralyze");
  assert.equal(match.waits.get(0), 2);
  assert.equal(match.turn, "black");
  assert.equal(match.battleEvidenceUsed, true);
  match.phase = "finished";
});

test("controlled Pokepower 1227 match preserves the native declaration deck and Gold-versus-Purple result", () => {
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    battleEvidenceMode: "native_bridge_1227_speedup_once",
  });
  const match = service.createMatch("battle-speedup-test");
  const defender = match.record.players[0].pokemons[0];
  const attacker = match.record.players[1].pokemons[0];
  assert.deepEqual(
    [defender.pokemon_index, defender.form_index, defender.id, defender.pokepower, defender.skills[1].id],
    [0, 0, 1273, 1227, 1372],
  );
  assert.deepEqual(
    [attacker.pokemon_index, attacker.form_index, attacker.id, attacker.skills[1].id],
    [6, 6, 1421, 1057],
  );
  const status = service.status(match, 3);
  assert.equal(status.online_match.player1.deck.user_deck_figures[0].figure_user_items[0].item_master_id, 1273);
  assert.equal(status.online_match.player2.deck.user_deck_figures[0].figure_user_items[0].item_master_id, 1421);

  const writes = [];
  match.phase = "started";
  match.turn = "white";
  match.positions.set(0, 15);
  match.positions.set(6, 11);
  match.socket = { destroyed: false, write: (value) => writes.push(value) };
  assert.equal(new Set(match.positions.values()).size, 12, "native color witness uses distinct legal field points");
  const promoted = customMatchTestHooks.selectedSkill(match, 0, 20);
  assert.deepEqual([promoted.id, promoted.original_color, promoted.color], [1372, 1, 3]);
  service.performBattleSpin(match, 6, 0, "white");

  const spinWire = writes.find((value) => value.includes(" do_move "));
  assert.ok(spinWire);
  const spin = JSON.parse(spinWire.slice(spinWire.indexOf(" do_move ") + " do_move ".length).trim());
  assert.deepEqual(spin.value.spins, [
    { pokemon: 0, results: [{ displace: 0, num: 20, type: "battle" }] },
    { pokemon: 6, results: [{ displace: 0, num: 8, type: "battle" }] },
  ]);
  assert.equal(match.battledAfterField.get(0), true);
  assert.equal(customMatchTestHooks.selectedSkill(match, 0, 20).color, 1, "the next battle no longer has Gale Wings promotion");
  assert.equal(customMatchTestHooks.selectedSkill(match, 6, 8).id, 1057);
  assert.equal(match.positions.get(6), 43);
  assert.equal(match.turn, "black");
  assert.equal(match.battleEvidenceUsed, true);
  match.phase = "finished";
});

test("opponent plate evidence mode is off by default and rejects unknown modes", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  assert.equal(service.opponentPlateMode, "off");
  assert.throws(
    () => new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0, opponentPlateMode: "invented" }),
    /invalid_opponent_plate_mode_invented/,
  );
  assert.equal(service.battleEvidenceMode, "off");
  assert.throws(
    () => new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0, battleEvidenceMode: "invented" }),
    /invalid_battle_evidence_mode_invented/,
  );
});

test("native-proven pokepower paralysis and wait state constrain legal movement", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("condition-test");
  match.positions.set(0, 15);
  match.positions.set(6, 19);
  const outcome = service.applyBaseBattleOutcome(match, 6, 0, 93, 90);
  assert.deepEqual(
    [outcome.attackerSkill.id, outcome.defenderSkill.id, outcome.winner, outcome.knockout],
    [1620, 1085, 6, false],
  );
  assert.equal(match.conditions.get(0), "paralyze");
  assert.equal(match.waits.get(0), 3);
  assert.equal(customMatchTestHooks.legalRoutes(match, "black").some(
    (move) => move.value.route[0] === 15,
  ), false);
  customMatchTestHooks.completeTurn(match, "white");
  assert.equal(match.waits.get(0), 2);
});

test("all 24 owned wheel pairings project the exact native post-turn state", () => {
  assert.equal(ownedWheelMatrix.schema, "kiwi-duel-native-wheel-matrix-1");
  assert.equal(ownedWheelMatrix.caseCount, 24);
  assert.equal(ownedWheelMatrix.cases.length, 24);
  for (const matrixCase of ownedWheelMatrix.cases) {
    const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
    const match = service.createMatch(matrixCase.name);
    match.positions.set(0, 15);
    match.positions.set(6, 11);

    service.applyBaseBattleOutcome(
      match,
      Number(ownedWheelMatrix.attacker),
      Number(ownedWheelMatrix.defender),
      Number(matrixCase.white.sample),
      Number(matrixCase.black.sample),
    );
    customMatchTestHooks.completeTurn(match, "white");

    const nativeDocument = JSON.parse(readFileSync(
      new URL(`${matrixCase.name}-status.json`, nativeWheelStatusRoot),
      "utf8",
    ));
    assert.equal(nativeDocument.cmd, "status", `${matrixCase.name}: native command`);
    assert.equal(match.turn, nativeDocument.status.selective_side, `${matrixCase.name}: turn`);
    for (const pokemon of [0, 6]) {
      const native = nativeDocument.status.pokemon_conditions.find(
        (condition) => Number(condition.pokemon_index) === pokemon,
      );
      assert.ok(native, `${matrixCase.name}: native Pokemon ${pokemon}`);
      assert.equal(match.positions.get(pokemon), Number(native.index), `${matrixCase.name}: Pokemon ${pokemon} position`);
      assert.equal(match.conditions.get(pokemon), String(native.marker.circle), `${matrixCase.name}: Pokemon ${pokemon} condition`);
      assert.equal(match.waits.get(pokemon), Number(native.wait), `${matrixCase.name}: Pokemon ${pokemon} wait`);
    }
  }
});

test("Blue 1127 retains its native Wait 2 without a later Pokepower override", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("blue-wait-test");
  match.positions.set(0, 15);
  match.positions.set(7, 11);
  const outcome = service.applyBaseBattleOutcome(match, 7, 0, 94, 55);
  assert.deepEqual([outcome.winner, outcome.loser, outcome.knockout], [0, 7, false]);
  assert.equal(match.waits.get(0), 2);
  customMatchTestHooks.completeTurn(match, "white");
  assert.equal(match.waits.get(0), 1);
});

test("overlapping post-battle positions remain side-aware and cannot be entered through an ally", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("overlap-test");
  match.positions.set(0, 15);
  match.positions.set(1, 20);
  match.positions.set(6, 15);

  const routes = customMatchTestHooks.legalRoutes(match, "black");
  assert.equal(routes.some((move) => (
    move.value.route[0] === 20 && move.value.route.at(-1) === 15
  )), false);

  customMatchTestHooks.applyPositionMove(match, {
    selective_side: "white",
    value: { route: [15, 11], type: "mp_move" },
  });
  assert.equal(match.positions.get(0), 15);
  assert.equal(match.positions.get(6), 11);

  match.positions.set(6, 15);
  customMatchTestHooks.applyPositionMove(match, {
    selective_side: "white",
    value: {
      plate_id: 5026,
      type: "declare_plate",
      value: { from: 15, to: 11, type: "spot_move" },
    },
  });
  assert.equal(match.positions.get(0), 15);
  assert.equal(match.positions.get(6), 11);
});

test("a late Android move is rejected without disconnecting the authenticated match", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("stale-touch-test");
  match.phase = "started";
  match.turn = "white";
  let destroyed = false;
  const socket = { destroyed: false, destroy: () => { destroyed = true; } };
  match.socket = socket;
  const priorError = console.error;
  console.error = () => {};
  try {
    service.handleLine(socket, { match }, 'do_move {"selective_side":"black","value":{"route":[28,27],"type":"mp_move"}}');
  } finally {
    console.error = priorError;
  }
  assert.equal(destroyed, false);
  assert.equal(match.record.all_moves.length, 0);
  assert.equal(match.turn, "white");
});

test("Z gauge actions carry absolute clamped results for both sides", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("z-gauge-test");
  const writes = [];
  match.phase = "started";
  match.socket = { destroyed: false, write: (value) => writes.push(value) };

  const first = service.addZGauge(match, { black: 10, white: 3 });
  const second = service.addZGauge(match, { black: 95, white: -9 });

  assert.deepEqual(first.value, {
    type: "add_z_gauge",
    black: 10,
    black_result: 10,
    white: 3,
    white_result: 3,
  });
  assert.deepEqual(second.value, {
    type: "add_z_gauge",
    black: 90,
    black_result: 100,
    white: -3,
    white_result: 0,
  });
  assert.deepEqual(match.zGauge, { black: 100, white: 0 });
  assert.equal(writes.filter((value) => value.includes('"type":"add_z_gauge"')).length, 2);
});

test("server-authoritative player clock broadcasts progress and loses at zero", () => {
  let now = 10_000;
  const service = new CustomMatchService({
    bindHost: "127.0.0.1",
    publicHost: "127.0.0.1",
    port: 0,
    initialTimeMs: 2_500,
    clockSource: () => now,
  });
  const match = service.createMatch("timeout-test");
  const writes = [];
  match.phase = "started";
  match.turn = "black";
  match.socket = { destroyed: false, write: (value) => writes.push(value) };
  service.matches.set(match.session, match);

  assert.equal(service.startMatchClock(match, "black"), true);
  now += 600;
  service.tickMatchTimers();
  assert.equal(match.blackTimeMs, 1_900);
  assert.ok(writes.some((value) => value.includes(" time black 1900")));

  now += 1_900;
  service.tickMatchTimers();
  assert.equal(match.blackTimeMs, 0);
  assert.equal(match.phase, "finished");
  assert.equal(match.winner, "white");
  assert.equal(match.reason, "timeout");
  assert.ok(writes.some((value) => value.includes(" match_finish white timeout")));
});

test("skill 1085 sleep and item 1414 retaliation match the controlled native branch", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("sleep-test");
  match.positions.set(0, 15);
  match.positions.set(6, 19);
  const outcome = service.applyBaseBattleOutcome(match, 6, 0, 12, 71);
  assert.deepEqual([outcome.winner, outcome.loser, outcome.knockout], [0, 6, false]);
  assert.equal(match.conditions.get(6), "sleep");
  assert.equal(match.conditions.get(0), "paralyze");
  assert.equal(match.waits.get(0), 3);
  assert.equal(customMatchTestHooks.legalRoutes(match, "white").some(
    (move) => move.value.route[0] === 19,
  ), false);
});

test("paralysis replaces the native-selected segment with Miss and enables 1621 double damage", () => {
  const service = new CustomMatchService({ bindHost: "127.0.0.1", publicHost: "127.0.0.1", port: 0 });
  const match = service.createMatch("disabled-skill-test");
  match.positions.set(0, 15);
  match.positions.set(6, 19);
  match.conditions.set(0, "paralyze");
  assert.equal(customMatchTestHooks.paralysisDisabledSkill(match, 0), 1127);
  match.disabledSkills.set(0, new Set([1127]));
  const disabled = customMatchTestHooks.selectedSkill(match, 0, 49);
  assert.deepEqual(
    [disabled.id, disabled.color, disabled.speed_or_damage, disabled.paralysis_replacement],
    [1131, 0, 0, true],
  );
  const outcome = service.applyBaseBattleOutcome(match, 0, 6, 49, 46);
  assert.deepEqual(
    [outcome.winner, outcome.loser, outcome.knockout, outcome.defenderSkill.speed_or_damage],
    [6, 0, true, 206],
  );
  assert.equal(match.positions.get(0), 41);
  assert.equal(match.conditions.get(0), "normal");
});
