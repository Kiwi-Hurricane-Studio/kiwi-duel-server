import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { completedBattleGaugeAwards, fieldPointZFromTable, turnStartGaugeAward } from "./z-gauge-rules.mjs";

for (const side of ["black", "white"]) {
  const enemy = side === "black" ? "white" : "black";
  test(`base Z award follows ${side} attacker, not winner or color ownership`, () => {
    for (const [attackerColor, defenderColor] of [[1, 1], [4, 1], [2, 4]]) {
      assert.deepEqual(completedBattleGaugeAwards({ attackingSide: side, attackerColor, defenderColor }), [
        { cause: "resolved_battle_and_final_miss", deltas: { black: 0, white: 0, [side]: 10 } },
      ]);
    }
  });
  test(`base Z final Miss and knockout remain separate for ${side}`, () => {
    assert.deepEqual(completedBattleGaugeAwards({ attackingSide: side, attackerColor: 1, defenderColor: 0, knockoutSide: enemy }), [
      { cause: "base_battle_knockout", deltas: { black: 0, white: 0, [enemy]: 10 } },
      { cause: "resolved_battle_and_final_miss", deltas: { [side]: 10, [enemy]: 5 } },
    ]);
    assert.deepEqual(completedBattleGaugeAwards({ attackingSide: side, attackerColor: 0, defenderColor: 1, knockoutSide: side }), [
      { cause: "base_battle_knockout", deltas: { black: 0, white: 0, [side]: 10 } },
      { cause: "resolved_battle_and_final_miss", deltas: { black: 0, white: 0, [side]: 15 } },
    ]);
    assert.deepEqual(completedBattleGaugeAwards({ attackingSide: side, attackerColor: 0, defenderColor: 0 }), [
      { cause: "resolved_battle_and_final_miss", deltas: { [side]: 15, [enemy]: 5 } },
    ]);
    assert.deepEqual(turnStartGaugeAward(side), { cause: "turn_started", deltas: { black: 0, white: 0, [side]: 3 } });
  });
}

test("base Z reducer rejects malformed facts and does not mutate or reuse result state", () => {
  const facts = Object.freeze({ attackingSide: "white", attackerColor: 0, defenderColor: 1, knockoutSide: "white" });
  const first = completedBattleGaugeAwards(facts);
  first[0].deltas.white = 999;
  assert.equal(completedBattleGaugeAwards(facts)[0].deltas.white, 10);
  for (const side of ["White", "neither", "", 0, null]) {
    assert.throws(() => turnStartGaugeAward(side), /invalid_z_gauge_side/);
    assert.throws(() => completedBattleGaugeAwards({ ...facts, attackingSide: side }), /invalid_z_gauge_side/);
  }
  for (const color of [-1, 5, 0.5, "0", NaN, undefined]) {
    assert.throws(() => completedBattleGaugeAwards({ ...facts, attackerColor: color }), /invalid_z_gauge_resolved_color/);
    assert.throws(() => completedBattleGaugeAwards({ ...facts, defenderColor: color }), /invalid_z_gauge_resolved_color/);
  }
  assert.throws(() => completedBattleGaugeAwards({ ...facts, knockoutSide: "both" }), /invalid_z_gauge_side/);
});

test("turn award consumes authored Z coordinates and one bonus per invading side, not per figure", () => {
  const bytes = readFileSync(new URL("../data/match_stage_contract.json", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "fa2d81163224c2068dabc2185c2d7b94634ea3a81431dfc5845fb4b17a00e3f7");
  const field = fieldPointZFromTable(JSON.parse(bytes).table);
  assert.equal(Object.isFrozen(field), true);
  assert.deepEqual(Object.keys(field).filter((point) => field[point] < 0).map(Number), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(Object.keys(field).filter((point) => field[point] === 0).map(Number), [12, 13, 14, 15]);
  assert.deepEqual(Object.keys(field).filter((point) => field[point] > 0).map(Number), Array.from({ length: 12 }, (_, index) => index + 16));
  for (const side of ["black", "white"]) {
    for (const [positions, expected] of [
      [[[0, 27], [6, 11]], 3],
      [[[0, 10], [6, 11]], 5],
      [[[0, 14], [6, 20]], 5],
      [[[0, 10], [6, 20]], 7],
      [[[0, 10], [6, 20], [7, 17]], 7],
      [[[0, 14], [6, 20], [7, 17]], 5],
      [[[0, 41], [6, 43], [1, 29], [7, 35]], 3],
      [[[0, 12], [1, 13], [6, 14], [7, 15]], 3],
    ]) {
      const before = structuredClone(positions);
      assert.deepEqual(turnStartGaugeAward(side, new Map(positions), field),
        { cause: "turn_started", deltas: { black: 0, white: 0, [side]: expected } });
      assert.deepEqual(positions, before);
    }
  }
});

test("turn geometry fails closed on malformed authored points or position identity", () => {
  const table = JSON.parse(readFileSync(new URL("../data/match_stage_contract.json", import.meta.url))).table;
  const field = fieldPointZFromTable(table);
  assert.throws(() => fieldPointZFromTable({ ...table, battlefield: { start: 0, count: 27 } }), /invalid_z_gauge_field_contract/);
  assert.throws(() => fieldPointZFromTable({ ...table, points: {} }), /invalid_z_gauge_field_point/);
  assert.throws(() => turnStartGaugeAward("black", [[0, 10]], {}), /invalid_z_gauge_field_point/);
  for (const positions of [[[0, 10], [0, 11]], [[12, 10]], [[0, 1.5]], [[0, 60]], [[0]], [["0", 10]]]) {
    assert.throws(() => turnStartGaugeAward("black", positions, field), /invalid_z_gauge_position/);
  }
  assert.throws(() => turnStartGaugeAward("black", {}, field), /invalid_z_gauge_positions/);
});
