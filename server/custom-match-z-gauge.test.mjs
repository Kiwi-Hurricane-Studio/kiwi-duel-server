import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CustomMatchService, customMatchTestHooks } from "./custom-match-engine.mjs";

// Native fixtures are test expectations only. Production must derive awards
// from accepted game causes, never read these responses or key rules by case.
const archive = new URL("../docs/generated/", import.meta.url);
const matrixDirectory = "battle-route-20260909/native-owned-wheel-matrix";
const chanceDirectory = "battle-route-20260908/double-chance-native-query";
const airDirectory = "plate-copy-state-20260910/native-air-balloon-battle";
const read = (relative) => JSON.parse(readFileSync(new URL(relative, archive), "utf8"));
const matrix = read("battle-route-20260906/custom-engine-authority/controlled-records/owned-route-wheel-matrix.json");

function verifiedQuery(directory, label, operation) {
  const manifest = read(`${directory}/manifest.json`);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.source_unchanged, true);
  const query = manifest.queries.find((entry) => entry.label === label && entry.operation === operation);
  assert.ok(query, `${label}/${operation} request/response binding`);
  assert.equal(query.exit_code, 0);
  const result = {};
  for (const kind of ["request", "response"]) {
    const bytes = readFileSync(new URL(`${directory}/${query[`${kind}_file`]}`, archive));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), query[`${kind}_sha256`]);
    result[kind] = JSON.parse(bytes);
  }
  return result;
}

function gauges(status) {
  return Object.fromEntries(status.z_gauge_conditions.map(({ color, z_gauge }) => [color, z_gauge]));
}

function nativeEvents(document) {
  assert.equal(document.cmd, "output_effects");
  let phase = "battle";
  return document.effect_moves.flatMap(({ value }) => {
    if (value.type === "turn_end") phase = "next_turn";
    if (value.type !== "add_z_gauge") return [];
    return [{ phase, ...value }];
  });
}

function expectedProjection(document, status) {
  return { events: nativeEvents(document), zGauge: gauges(status), turn: status.turn };
}

function isolatedBattle(t, units = []) {
  const service = new CustomMatchService({
    port: 0, moveDelayMs: 0, opponentTurnDelayMs: 0,
    spinUnitSource: (maximum) => {
      assert.equal(maximum, 96);
      const unit = units.shift();
      assert.ok(Number.isInteger(unit) && unit >= 0 && unit < maximum, "exact supplied native wheel unit");
      return unit;
    },
  });
  // Exercise the real synchronous authoritative paths without listening on a
  // socket or letting timers make decisions outside this fixture's boundary.
  service.playOpponentTurn = () => {};
  service.declareOpponentRespin = () => {};
  service.resolveBattle = () => {};
  const match = service.createMatch("isolated-native-z-gauge-regression");
  match.phase = "started";
  match.turn = "white";
  match.socket = { destroyed: false, write: () => {}, destroy: () => assert.fail("isolated native action was rejected") };
  t.after(() => { match.phase = "finished"; });
  return { service, match };
}

function observeGaugeEmissions(service, match) {
  const initialTurn = match.turn;
  const events = [];
  const emit = service.addZGauge.bind(service);
  service.addZGauge = (target, deltas, cause) => {
    const phase = target.turn === initialTurn ? "battle" : "next_turn";
    const action = emit(target, deltas, cause);
    if (action) events.push({ phase, ...action.value });
    return action;
  };
  return () => ({ events, zGauge: { ...match.zGauge }, turn: match.turn });
}

function installNativeField(match, status) {
  match.turn = status.turn;
  match.zGauge = gauges(status);
  for (const pokemon of status.pokemon_conditions) {
    match.positions.set(pokemon.pokemon_index, pokemon.index);
    match.conditions.set(pokemon.pokemon_index, pokemon.marker.circle);
    match.waits.set(pokemon.pokemon_index, pokemon.wait);
  }
}

test("native Z fixture matrix has 24 coherent ordered event/status pairs", () => {
  assert.equal(matrix.schema, "kiwi-duel-native-wheel-matrix-1");
  assert.equal(matrix.caseCount, 24);
  assert.equal(matrix.cases.length, 24);
  for (const entry of matrix.cases) {
    const effects = read(`${matrixDirectory}/${entry.name}-output_effects.json`);
    const status = read(`${matrixDirectory}/${entry.name}-status.json`).status;
    const previous = { black: 3, white: 6 };
    for (const event of nativeEvents(effects)) {
      for (const side of ["black", "white"]) {
        previous[side] += event[side];
        assert.equal(previous[side], event[`${side}_result`], `${entry.name}: ordered absolute ${side}`);
      }
    }
    assert.deepEqual(previous, gauges(status), `${entry.name}: final native status`);
    assert.equal(status.turn, "black");
  }
});

for (const entry of matrix.cases) {
  test(`Z native ordered awards and final status: ${entry.name}`, (t) => {
    const effects = read(`${matrixDirectory}/${entry.name}-output_effects.json`);
    const status = read(`${matrixDirectory}/${entry.name}-status.json`).status;
    const { service, match } = isolatedBattle(t, [entry.white.sample, entry.black.sample]);
    match.positions.set(0, 15);
    match.positions.set(6, 11);
    // The preserved matrix starts with black 3 / white 6. The fixture integrity
    // test checks every subsequent emitted absolute result from that checkpoint.
    match.zGauge = { black: 3, white: 6 };
    const actual = observeGaugeEmissions(service, match);
    service.performBattleSpin(match, matrix.attacker, matrix.defender, "white");
    assert.deepEqual(actual(), expectedProjection(effects, status));
  });
}

for (const role of ["attacker", "defender"]) {
  test(`Z exact hashed Air Balloon ${role} battle prefix and native final status`, (t) => {
    const before = verifiedQuery(airDirectory, `${role}-declare-battle`, "status");
    const after = verifiedQuery(airDirectory, `${role}-native-spin`, "status");
    const effects = verifiedQuery(airDirectory, `${role}-native-spin`, "output_effects").response;
    const spin = after.request.record.all_moves.at(-1).value;
    const units = [6, 0].map((pokemon) => spin.spins.find((entry) => entry.pokemon === pokemon).results[0].num);
    const { service, match } = isolatedBattle(t, units);
    match.turn = "black";
    for (const player of match.record.players) {
      const original = before.request.record.players.find((entry) => entry.color === player.color);
      player.plates = [...original.plates];
      player.pokemons = structuredClone(original.pokemons);
    }
    for (const move of before.request.record.all_moves) service.acceptPlayerMove(match, move, move.selective_side);
    assert.deepEqual(match.zGauge, gauges(before.response.status), "real prefix awards agree before disputed battle");
    assert.equal(match.turn, before.response.status.turn);
    const actual = observeGaugeEmissions(service, match);
    service.performBattleSpin(match, 6, 0, "white");
    assert.deepEqual(actual(), expectedProjection(effects, after.response.status));
  });
}

function doubleChanceBattle(t, units) {
  const before = read(`${chanceDirectory}/double-chance-adjacent-declare-status.json`).status;
  const context = isolatedBattle(t, units);
  const { service, match } = context;
  installNativeField(match, before);
  service.appendMove(match, {
    selective_side: "white",
    value: { type: "declare_plate", plate_id: 5015, value: { type: "select_pokemon", pokemon: 6 } },
  });
  match.pendingPlate = { side: "white", plateId: 5015, pokemon: 6 };
  return context;
}

for (const branch of ["miss", "nonmiss"]) {
  test(`Z Double Chance ${branch} provisional first result does not award or end turn`, (t) => {
    const prefix = `${chanceDirectory}/after-double-chance-adjacent-${branch}`;
    const effects = read(`${prefix}-output_effects.json`);
    const status = read(`${prefix}-status.json`).status;
    const spin = effects.effect_moves.find(({ value }) => value.type === "spin").value;
    const units = [6, 0].map((pokemon) => spin.spins.find((entry) => entry.pokemon === pokemon).results[0].num);
    const { service, match } = doubleChanceBattle(t, units);
    const actual = observeGaugeEmissions(service, match);
    service.performBattleSpin(match, 6, 0, "white");
    assert.ok(match.pendingRespin);
    assert.deepEqual(actual(), expectedProjection(effects, status));
  });
}

test("Z Double Chance selected second result awards once and matches exact native status", (t) => {
  const effects = read(`${chanceDirectory}/after-second-spin-output_effects.json`);
  const status = read(`${chanceDirectory}/after-second-spin-status.json`).status;
  const { service, match } = doubleChanceBattle(t, [3, 41, 34]);
  const actual = observeGaugeEmissions(service, match);
  service.performBattleSpin(match, 6, 0, "white");
  assert.deepEqual(actual().events, []);
  assert.ok(match.pendingRespin);
  match.pendingRespin.declared = true;
  CustomMatchService.prototype.performPendingRespin.call(service, match);
  assert.deepEqual(actual(), expectedProjection(effects, status));
});

for (const directory of ["z-gauge-rules-20260910/native-neutral-matrix", "z-gauge-rules-20260910/native-authored-black"]) {
  const manifest = read(`${directory}/manifest.json`);
  for (const entry of manifest.cases) {
    const inputMode = "accepted prefix replay";
    test(`Z fresh role contrast ${entry.name}: ${inputMode} and exact native awards`, (t) => {
      const before = verifiedQuery(directory, `${entry.name}-before-spin`, "status");
      const after = verifiedQuery(directory, `${entry.name}-after-spin`, "status");
      const effects = verifiedQuery(directory, `${entry.name}-after-spin`, "output_effects").response;
      const result = effects.effect_moves.find(({ value }) => value.type === "battle_result").value;
      const attacker = result.attack.pokemon;
      const defender = result.defence.pokemon;
      const spin = after.request.record.all_moves.at(-1).value;
      const units = [attacker, defender].map((pokemon) => spin.spins.find((row) => row.pokemon === pokemon).results[0].num);
      const { service, match } = isolatedBattle(t, units);
      match.turn = "black";
      for (const player of match.record.players) {
        const authored = before.request.record.players.find((row) => row.color === player.color);
        player.pokemons = structuredClone(authored.pokemons);
        player.plates = [...authored.plates];
      }
      for (const move of before.request.record.all_moves) service.acceptPlayerMove(match, move, move.selective_side);
      assert.equal(match.turn, before.response.status.turn);
      assert.deepEqual(match.zGauge, gauges(before.response.status), inputMode);
      assert.deepEqual([...match.positions.entries()], before.response.status.pokemon_conditions.map((row) => [row.pokemon_index, row.index]));
      const actual = observeGaugeEmissions(service, match);
      service.performBattleSpin(match, attacker, defender, entry.side);
      assert.deepEqual(actual(), expectedProjection(effects, after.response.status));
    });
  }
}

test("fresh authored black-turn direct battle alternatives match native with no movement pending", (t) => {
  const directory = "z-gauge-rules-20260910/native-authored-black";
  const native = verifiedQuery(directory, "authored-black-black-turn", "legal_moves");
  const { service, match } = isolatedBattle(t);
  match.turn = "black";
  for (const action of native.request.record.all_moves) service.acceptPlayerMove(match, action, action.selective_side);
  assert.equal(match.turn, "black");
  assert.deepEqual(match.pendingBattles, []);
  const actions = [];
  for (let attacker = 0; attacker < 12; attacker += 1) {
    for (let defender = 0; defender < 12; defender += 1) {
      const action = { selective_side: "black", value: { from_pokemon: attacker, to_pokemon: defender, type: "declare_battle" } };
      if (customMatchTestHooks.validateBattleDeclaration(match, "black", action)) actions.push(action);
    }
  }
  assert.deepEqual(actions, native.response.legal_moves.filter(({ value }) => value.type === "declare_battle"));
  assert.equal(actions.length, 1);
  service.acceptPlayerMove(match, actions[0], "black");
  assert.equal(match.battleResolutionPending, true);
  const before = match.record.all_moves.length;
  let error;
  service.rejectPlayerMove = (_match, reason) => { error = reason; };
  service.acceptPlayerMove(match, actions[0], "black");
  assert.equal(error, "battle_resolution_pending");
  assert.equal(match.record.all_moves.length, before, "no duplicate declaration before spin resolution");
});

test("direct adjacent battle rejects wrong authority, invalid geometry, ineligible and stale participants", (t) => {
  const { match } = isolatedBattle(t);
  match.turn = "black";
  match.positions.set(0, 15);
  match.positions.set(6, 11);
  const action = { selective_side: "black", value: { type: "declare_battle", from_pokemon: 0, to_pokemon: 6 } };
  const valid = () => customMatchTestHooks.validateBattleDeclaration(match, "black", action);
  assert.equal(valid(), true);
  for (const phase of ["waiting", "finished", "reset"]) {
    match.phase = phase; assert.equal(valid(), false);
  }
  match.phase = "started";
  match.turn = "white"; assert.equal(valid(), false); match.turn = "black";
  match.pendingRespin = {}; assert.equal(valid(), false); match.pendingRespin = null;
  match.battleResolutionPending = true; assert.equal(valid(), false); match.battleResolutionPending = false;
  match.waits.set(0, 1); assert.equal(valid(), false); match.waits.set(0, 0);
  match.conditions.set(0, "sleep"); assert.equal(valid(), false); match.conditions.set(0, "normal");
  for (const point of [28, 41, -1, 0.5, 0]) {
    match.positions.set(0, point); assert.equal(valid(), false);
  }
  match.positions.set(0, 15);
  for (const point of [34, 43, -1, 15, 0]) {
    match.positions.set(6, point); assert.equal(valid(), false);
  }
  match.positions.set(6, 11);
  for (const target of [0, 1, 12, -1, "6", 6.5]) {
    assert.equal(customMatchTestHooks.validateBattleDeclaration(match, "black", { ...action, value: { ...action.value, to_pokemon: target } }), false);
  }
  assert.equal(customMatchTestHooks.validateBattleDeclaration(match, "white", action), false);
  match.pendingPlate = { side: "black", pokemon: 1, plateId: 5022 }; assert.equal(valid(), false);
  match.pendingPlate = null;
  match.pendingBattles = [{ selective_side: "black", value: { type: "declare_battle", from_pokemon: 1, to_pokemon: 6 } }];
  assert.equal(valid(), false, "a different actor's pending movement is not a fresh free-selection turn");
  match.pendingBattles = [action];
  assert.equal(valid(), true);
  match.positions.set(6, 0); assert.equal(valid(), false, "stale pending option does not authorize displaced geometry");
});

const capDirectory = "z-gauge-rules-20260910/native-cap-exact-routes";
const capManifest = read(`${capDirectory}/manifest.json`);

test("native legal 66-turn prefix reaches exact 90/93/96/99 gauge checkpoints from zero", (t) => {
  const entry = capManifest.cases.find(({ name }) => name === "neutral-turn-cap");
  const opening = verifiedQuery(capDirectory, entry.checkpoints[0].label, "status");
  const { service, match } = isolatedBattle(t);
  match.turn = "black";
  for (const player of match.record.players) {
    const original = opening.request.record.players.find((row) => row.color === player.color);
    player.pokemons = structuredClone(original.pokemons);
    player.plates = [...original.plates];
  }
  let accepted = 0;
  for (const checkpoint of entry.checkpoints) {
    const native = verifiedQuery(capDirectory, checkpoint.label, "status");
    const effects = verifiedQuery(capDirectory, checkpoint.label, "output_effects").response;
    let lastEvents = [];
    while (accepted < native.request.record.all_moves.length) {
      const action = native.request.record.all_moves[accepted++];
      const beforeCount = match.record.all_moves.length;
      service.acceptPlayerMove(match, action, action.selective_side);
      lastEvents = match.record.all_moves.slice(beforeCount).map(({ value }) => value).filter(({ type }) => type === "add_z_gauge");
    }
    assert.deepEqual(match.zGauge, gauges(native.response.status), checkpoint.label);
    assert.equal(match.turn, native.response.status.turn);
    assert.deepEqual(lastEvents, effects.effect_moves.map(({ value }) => value).filter(({ type }) => type === "add_z_gauge"));
  }
  assert.equal(accepted, 66);
});

for (const entry of capManifest.cases.filter(({ name }) => name !== "neutral-turn-cap")) {
  test(`native capped award events remain distinct: ${entry.name}`, (t) => {
    const approach = verifiedQuery(capDirectory, `${entry.name}-after-black-approach`, "status");
    const approachEffects = verifiedQuery(capDirectory, `${entry.name}-after-black-approach`, "output_effects").response;
    const before = verifiedQuery(capDirectory, `${entry.name}-before-spin`, "status");
    const after = verifiedQuery(capDirectory, `${entry.name}-after-spin`, "status");
    const effects = verifiedQuery(capDirectory, `${entry.name}-after-spin`, "output_effects").response;
    const spin = after.request.record.all_moves.at(-1).value;
    const units = [6, 0].map((pokemon) => spin.spins.find((row) => row.pokemon === pokemon).results[0].num);
    const { service, match } = isolatedBattle(t, units);
    match.turn = "black";
    for (const player of match.record.players) {
      const original = before.request.record.players.find((row) => row.color === player.color);
      player.pokemons = structuredClone(original.pokemons);
      player.plates = [...original.plates];
    }
    for (const [index, action] of before.request.record.all_moves.entries()) {
      const beforeCount = match.record.all_moves.length;
      service.acceptPlayerMove(match, action, action.selective_side);
      if (index + 1 === approach.request.record.all_moves.length) {
        assert.deepEqual(match.zGauge, gauges(approach.response.status));
        assert.deepEqual(
          match.record.all_moves.slice(beforeCount).map(({ value }) => value).filter(({ type }) => type === "add_z_gauge"),
          approachEffects.effect_moves.map(({ value }) => value).filter(({ type }) => type === "add_z_gauge"),
          "native +3 cause reports actual +1 when white 99 reaches 100",
        );
      }
    }
    assert.deepEqual(match.zGauge, gauges(before.response.status), "all legal ordinary prefix awards reach native 99/100");
    const actual = observeGaugeEmissions(service, match);
    service.performBattleSpin(match, 6, 0, "white");
    assert.deepEqual(actual(), expectedProjection(effects, after.response.status));
  });
}

test("accepted capped causes append separate sequenced zero events; explicit zero and finished state remain no-ops", (t) => {
  const { service, match } = isolatedBattle(t);
  match.zGauge = { black: 100, white: 100 };
  const writes = [];
  match.socket.write = (line) => writes.push(line);
  assert.equal(service.addZGauge(match, { black: 0, white: 0 }), null);
  assert.equal(match.record.all_moves.length, 0);
  service.applyZGaugeAwards(match, [
    { cause: "base_battle_knockout", deltas: { black: 10, white: 0 } },
    { cause: "resolved_battle_and_final_miss", deltas: { black: 5, white: 10 } },
    { cause: "turn_started", deltas: { black: 3, white: 0 } },
  ]);
  assert.equal(match.record.all_moves.length, 3);
  assert.equal(writes.filter((line) => line.includes(" do_move ")).length, 3);
  for (const { value } of match.record.all_moves) assert.deepEqual(value, {
    type: "add_z_gauge", black: 0, black_result: 100, white: 0, white_result: 100,
  });
  match.phase = "finished";
  assert.equal(service.addZGauge(match, { black: 3, white: 0 }, "turn_started"), null);
  assert.equal(match.record.all_moves.length, 3);
});
