// Native-proven base awards, isolated from sockets, persistence and fixtures.
// Evidence: z-gauge-rules-20260910/native-neutral-matrix (both attack roles,
// no abilities) plus native-authored-black and the 24 authored wheel pairs.
// This module does not model ability/plate Z modifiers, non-battle KOs, or
// extra-turn rules. Turn geometry follows the later native position contrasts.

function requireSide(side) {
  if (side !== "black" && side !== "white") throw new TypeError("invalid_z_gauge_side");
  return side;
}

function requireColor(color) {
  if (!Number.isInteger(color) || color < 0 || color > 4) throw new TypeError("invalid_z_gauge_resolved_color");
  return color;
}

export function completedBattleGaugeAwards({ attackingSide, attackerColor, defenderColor, knockoutSide = null }) {
  requireSide(attackingSide);
  requireColor(attackerColor);
  requireColor(defenderColor);
  if (knockoutSide !== null) requireSide(knockoutSide);
  const defendingSide = attackingSide === "black" ? "white" : "black";
  const awards = [];
  // A committed base-battle KO is a separate, earlier cause. It must not be
  // folded into the later award: per-event clamping and animation are visible.
  if (knockoutSide !== null) {
    awards.push({ cause: "base_battle_knockout", deltas: { black: 0, white: 0, [knockoutSide]: 10 } });
  }
  const deltas = { black: 0, white: 0, [attackingSide]: 10 };
  if (attackerColor === 0) deltas[attackingSide] += 5;
  if (defenderColor === 0) deltas[defendingSide] += 5;
  awards.push({ cause: "resolved_battle_and_final_miss", deltas });
  return awards;
}

export function fieldPointZFromTable(table) {
  if (table?.battlefield?.start !== 0 || table.battlefield.count !== 28) throw new TypeError("invalid_z_gauge_field_contract");
  const result = {};
  for (let point = 0; point < 28; point += 1) {
    const position = table.points?.[String(point).padStart(2, "0")]?.local_position;
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) {
      throw new TypeError("invalid_z_gauge_field_point");
    }
    result[point] = position[2];
  }
  return Object.freeze(result);
}

export function turnStartGaugeAward(nextSide, positions = [], fieldPointZ = null) {
  requireSide(nextSide);
  if (!(positions instanceof Map) && !Array.isArray(positions)) throw new TypeError("invalid_z_gauge_positions");
  let blackInvading = false, whiteInvading = false, ownExcluded = 0;
  const seen = new Set();
  for (const row of positions) {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError("invalid_z_gauge_position");
    const [pokemon, point] = row;
    if (!Number.isInteger(pokemon) || pokemon < 0 || pokemon >= 12 || seen.has(pokemon)
        || !Number.isInteger(point) || point < -1 || point >= 60) throw new TypeError("invalid_z_gauge_position");
    seen.add(pokemon);
    // Original ARM exclusion contrasts: each personal exclusion slot adds4
    // only to its figure's team when that team's turn starts. P.C. and bench
    // figures add nothing. Count the current post-resolution disposition.
    if (point === 44 + pokemon && (pokemon < 6 ? "black" : "white") === nextSide) ownExcluded += 1;
    if (point < 0 || point >= 28) continue;
    const z = fieldPointZ?.[point];
    if (!Number.isFinite(z)) throw new TypeError("invalid_z_gauge_field_point");
    if (pokemon < 6 && z < 0) blackInvading = true;
    if (pokemon >= 6 && z > 0) whiteInvading = true;
  }
  // Native31 completed-turn contrasts: the same board rate goes to whichever
  // side starts. A second invading figure of one side adds no second bonus.
  // Read post-resolution positions: a just-knocked-out invader no longer counts.
  const amount = 3 + 2 * Number(blackInvading) + 2 * Number(whiteInvading) + 4 * ownExcluded;
  return { cause: "turn_started", deltas: { black: 0, white: 0, [nextSide]: amount } };
}
