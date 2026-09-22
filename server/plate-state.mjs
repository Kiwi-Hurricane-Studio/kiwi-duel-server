// Owned-engine plate identity is one equipped slot, never one aggregate master ID.
// Native status/effect witnesses: docs/generated/full-port-audit-20260910/plates.
// This module does not invent recharge/removal or occupied-point pass-through.
import {SUPPORTED_SPHERE_IDS} from './sphere-plates.mjs';
export const PLATE_CONDITIONS = Object.freeze(["unused", "used", "active", "aura", "removed"]);
export const SUPPORTED_PLATE_IDS = Object.freeze([5002, 5015, 5022, 5023, 5026, 5306, 5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416, 5426, 5445]);
const sides = ["black", "white"];
const clone = (value) => structuredClone(value);

export function equippedPlateBinding(record) {
  return sides.map((side) => {
    const players = (record.players || []).filter((player) => player.color === side);
    if (players.length !== 1 || !Array.isArray(players[0].plates)
        || players[0].plates.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("plate_equipment_invalid");
    }
    return { color: side, plates: [...players[0].plates] };
  });
}

export function createPlateState(record) {
  const equipment = equippedPlateBinding(record);
  return {
    schema: 1,
    equipment,
    plate_conditions: equipment.map(({ color, plates }) => ({
      color, plates: plates.map((id) => ({ id, condition: "unused", turns: -1 })),
    })),
    attachments: [],
    // Only populated when an authoritative record provides the figure data;
    // status-only fixture adapters cannot invent missing authored MP values.
    figure_mp: Object.fromEntries(record.players.flatMap((player) => (player.pokemons || [])
      .filter((pokemon) => Number.isSafeInteger(pokemon.pokemon_index) && Number.isSafeInteger(pokemon.mp))
      .map((pokemon) => [pokemon.pokemon_index, pokemon.mp]))),
    declarations: [],
    unresolved_transitions: [],
  };
}

function copies(state, side) {
  if (!sides.includes(side)) throw new Error("plate_side_invalid");
  return state.plate_conditions.find((entry) => entry.color === side).plates;
}

export function availablePlateCopy(state, side, plateId) {
  if (!SUPPORTED_PLATE_IDS.includes(plateId)) return -1;
  return copies(state, side).findIndex((copy) => copy.id === plateId && copy.condition === "unused");
}

export function applyPlateDeclaration(state, move, moveIndex) {
  const side = move.selective_side;
  const plateId = move.value?.plate_id;
  if (move.value?.type !== "declare_plate" || !Number.isSafeInteger(moveIndex) || moveIndex < 0) {
    throw new Error("plate_declaration_invalid");
  }
  // A replay duplicate is not a second use. A different declaration at the
  // same authoritative index is a corrupt prefix, not a replacement action.
  const prior = state.declarations.find((entry) => entry.move_index === moveIndex);
  if (prior) {
    if (JSON.stringify(prior.move) !== JSON.stringify(move)) throw new Error("plate_declaration_prefix_conflict");
    return clone(prior.copy);
  }
  const slot = availablePlateCopy(state, side, plateId);
  if (slot < 0) throw new Error("plate_copy_unavailable");
  const copy = copies(state, side)[slot];
  const target = move.value.value || {};
  const identity = { side, slot, plate_id: plateId };
  // Target eligibility belongs to the owning engine's current board state.
  // A Frost-suppressed holder can receive another Metal copy; declaration
  // projection retains both equipped slots without guessing aura suppression.
  if ([5015, 5022, 5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416, 5426, 5445].includes(plateId)) {
    if (!Number.isSafeInteger(target.pokemon) || target.pokemon < 0 || target.pokemon >= 12
        || (target.pokemon < 6 ? "black" : "white") !== side) {
      throw new Error("plate_attachment_target_invalid");
    }
    const effect = [5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416].includes(plateId) ? { charge_effect: true } : [5426, 5445].includes(plateId)
      ? { charge_effect: true, ids: { plates: [plateId] } }
      : { plate_id: [plateId], ...(plateId === 5022 ? { damage_plus: 30 } : {}) };
    // Native effect.mp is an additive modifier, not absolute movement points.
    // MP1 target2 witnesses +1 after Air Balloon; MP2 target0 omits zero.
    // Opening -1 seen beside X Attack is a separate first-turn penalty and is
    // deliberately not copied into this plate-only effect contribution.
    const authoredMp = state.figure_mp[target.pokemon];
    if (plateId === 5426 && Number.isSafeInteger(authoredMp) && authoredMp !== 2) effect.mp = 2 - authoredMp;
    state.attachments.push({ ...identity, pokemon: target.pokemon, effect });
  }
  copy.condition = [5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416, 5426, 5445].includes(plateId) ? "aura" : [5015, 5022].includes(plateId) ? "active" : "used";
  state.declarations.push({ move_index: moveIndex, move: clone(move), copy: identity });
  return clone(identity);
}

export function completePlateTurn(state, side) {
  const plates = copies(state, side);
  for (let slot = 0; slot < plates.length; slot += 1) {
    const copy = plates[slot];
    if ([5015, 5022].includes(copy.id) && copy.condition === "active") {
      // Native after-second-spin and after-double-chance-battle-move statuses
      // both resolve 5015 to used; neither permits consuming another copy.
      // Fresh native-matrix-utf8 5022-pass-1 and 5022-move-1 likewise emit
      // disable_plate before turn_end and clear the selected figure's effect.
      copy.condition = "used";
      state.attachments = state.attachments.filter((entry) => entry.side !== side || entry.slot !== slot);
    } else if (copy.id === 5426 && copy.condition === "aura") {
      // Fresh pass/move witnesses establish aura persistence across turn_end.
      // Occupied-point pass-through still needs its separate witnesses.
      if (!state.unresolved_transitions.some((entry) => entry.side === side && entry.slot === slot)) {
        state.unresolved_transitions.push({ side, slot, plate_id: copy.id, boundary: "occupied_point_pass_through_not_native_verified" });
      }
    }
  }
}

export function completePlateBattle(state, battlingPokemon, {includeOneBattlePlates = false} = {}) {
  if (!Array.isArray(battlingPokemon) || battlingPokemon.some((pokemon) => !Number.isSafeInteger(pokemon) || pokemon < 0 || pokemon >= 12)) {
    throw new Error("plate_battle_targets_invalid");
  }
  // Native attacker/defender witnesses remove only the attached participant's
  // 5426 via disable_plate_for_one_pokemon immediately before turn_end. This
  // runs at completed battle resolution, never merely on declare_battle or a
  // first spin whose Double Chance choice is still unresolved.
  // X Attack and Double Chance also last for one battle. Usually the battle
  // and turn end together; Double Flight can settle the battle earlier.
  const removed = state.attachments.filter((entry) => (entry.plate_id === 5426 || includeOneBattlePlates && [5015, 5022].includes(entry.plate_id)) && battlingPokemon.includes(entry.pokemon));
  for (const entry of removed) {
    const copy = copies(state, entry.side)[entry.slot];
    if (copy.id !== entry.plate_id || copy.condition !== (entry.plate_id === 5426 ? "aura" : "active")) throw new Error("plate_attachment_condition_invalid");
  }
  for (const entry of removed) copies(state, entry.side)[entry.slot].condition = "used";
  const removedCopy = (entry) => removed.some((copy) => copy.side === entry.side && copy.slot === entry.slot);
  state.attachments = state.attachments.filter((entry) => !removedCopy(entry));
  state.unresolved_transitions = state.unresolved_transitions.filter((entry) => !removedCopy(entry));
  return clone(removed);
}

export function plateConditionsSnapshot(state) {
  // Native status sorts master IDs even when the equipped deck is differently
  // ordered. Stable equal-ID ordering maps nth occurrence to nth equipped copy;
  // a native row ordinal must never be reused as an equipped slot identifier.
  return clone(state.plate_conditions).map(({ color, plates }) => ({
    color, plates: plates.sort((left, right) => left.id - right.id),
  }));
}

export function disableSphereAttachments(state, pokemon) {
  const removed = state.attachments.filter(a => SUPPORTED_SPHERE_IDS.includes(a.plate_id) && a.pokemon === pokemon);
  for (const a of removed) {
    if (copies(state, a.side)[a.slot]?.condition !== 'aura') throw new Error('sphere_attachment_condition_invalid');
  }
  for (const a of removed) copies(state, a.side)[a.slot].condition = 'used';
  state.attachments = state.attachments.filter(a => !removed.includes(a));
  return clone(removed);
}

export function plateAttachmentSnapshot(state) {
  return clone(state.attachments);
}

export function hasAirBalloonAttachment(state, pokemon) {
  return Boolean(state?.attachments.some((entry) => entry.plate_id === 5426 && entry.pokemon === pokemon
    && copies(state, entry.side)[entry.slot]?.condition === "aura"));
}

// This is only the declaration projection of a previously recorded prefix.
// It deliberately does not infer generic turn ends from arbitrary movement or
// native automatic effects; the owning engine supplies proven turn boundaries.
export function replayPlateDeclarations(record) {
  const state = createPlateState(record);
  for (const [index, move] of (record.all_moves || []).entries()) {
    if (move.value?.type === "declare_plate") applyPlateDeclaration(state, move, index);
    if (move.value?.type === "declare_turn_end" && sides.includes(move.selective_side)) completePlateTurn(state, move.selective_side);
  }
  return state;
}
