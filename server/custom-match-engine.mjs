import {applyWait} from './wait-immunity.mjs';
import {isSphereTarget, SUPPORTED_SPHERE_IDS, sphereAttachmentSuppressed, applySphereDamage, spherePreventionPlate, flameSphereTransitPairs, phantomSphereTransitPairs, electroSphereTransitPairs, dragonSphereTransitPairs, darkSphereAbilityTransitBlocks, stonySphereAbilityTransitBlocks, sphereMovementMp} from './sphere-plates.mjs';
import {grudgeStoneEntry,grudgeStoneChoices,validGrudgeSelection} from './grudge-stone.mjs';
import {touchRecoveryChoices,validTouchRecovery} from './touch-recovery.mjs';
import {restrictPostMpBattles,latestMpMover} from './post-mp-battles.mjs';
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  applyPlateDeclaration, availablePlateCopy, completePlateTurn, completePlateBattle, createPlateState,
  equippedPlateBinding, plateAttachmentSnapshot, plateConditionsSnapshot,
  hasAirBalloonAttachment, disableSphereAttachments,
} from "./plate-state.mjs";
import { completedBattleGaugeAwards, fieldPointZFromTable, turnStartGaugeAward } from "./z-gauge-rules.mjs";
import { deriveZChoices, effectiveZSkill } from "./z-skill-catalog.mjs";
import {
  advanceZTransaction, applyZGaugeCause, copyZTransactionState, createZTransactionState,
  filterZPlayerContinuations, finishZBattle, finishZNonbattleTurn, selectZTransaction,
} from "./z-skill-transaction.mjs";
import {
  createLedger, inspectLedger, proposeCompletion, commitCompletion, snapshotLedger, FACT_SCHEMA, MAX_COMPLETIONS,
} from "./completed-turn-ledger.mjs";
import { canonicalToken } from "./timed-exclusion-state.mjs";
import { conditionImmunitySources } from "./condition-immunity.mjs";
import { benchAttackPlan } from "./bench-attacks.mjs";
import { plateRestrictionSources } from "./plate-restrictions.mjs";
import { applyDamageAuras, applyFieldCountDamage } from "./damage-auras.mjs";
import { applyPurpleStars } from "./purple-stars.mjs";
import { effectKnockoutProtectionSources, purpleEffectKnockoutPlan } from "./effect-knockouts.mjs";
import { purpleWaitPlan } from "./purple-wait.mjs";
import { purpleConditionPlan } from "./purple-conditions.mjs";
import { surroundingPlan } from "./surrounding.mjs";
import { purpleJumpPlan } from "./purple-jump.mjs";
import { battleColorActions, applyBattleColorActions } from "./battle-colors.mjs";
import { fieldEntryRecoveryPlan, applyFieldEntryRecovery } from "./field-entry-recovery.mjs";
import { disguiseEntryTargets, consumeDisguiseMarkers } from "./disguise-marker.mjs";
import { applyBattleDamageReduction } from "./battle-damage-reductions.mjs";
import { applyFieldDamageReductions } from "./field-damage-reductions.mjs";
import { hasBenchSpotEntry, benchSpotEntryTargets, hasMovementTransit, movementTransitContext, canAbilityTransit, movementNonAbilityTransitBlockers, entryBlockadeMpBonus, movementMpBlockers, unverifiedTransitRouteBlockers } from "./movement-transit.mjs";

const LOCAL_USER_ID = 900000001;
const OPPONENT_USER_ID = 900000002;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// Original ConditionMaster descriptions explicitly label these eight as
// special conditions. Wait and ability/plate markers are separate categories.
const SPECIAL_CONDITIONS = new Set(['bad_poison', 'burn', 'freeze', 'melt', 'panic', 'paralyze', 'poison', 'sleep']);
// All three original ConditionDescription entries forbid using the affected
// figure until the specified tag/battle recovery. This is the use gate only.
const USE_BLOCKING_CONDITIONS = new Set(['sleep', 'freeze', 'melt']);

const FIELD_EDGES = [
  [0, 1], [0, 7], [0, 8], [1, 2], [2, 3], [2, 9], [3, 4], [4, 5],
  [5, 6], [6, 10], [6, 11], [7, 12], [8, 9], [8, 13], [9, 10],
  [10, 14], [11, 15], [12, 16], [13, 17], [14, 19], [15, 20],
  [16, 21], [17, 18], [17, 21], [18, 19], [18, 25], [19, 27],
  [20, 27], [21, 22], [22, 23], [23, 24], [24, 25], [25, 26], [26, 27],
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function grudgeBinding(match,pending) {
  return canonicalToken({record:match.record,turn:match.turn,positions:[...match.positions],
    conditions:[...match.conditions],triangles:[...match.triangles],waits:[...match.waits],
    pending:{side:pending.side,pokemon:pending.pokemon,entryMove:pending.entryMove,entryIndex:pending.entryIndex,declared:pending.declared,target:pending.target??null}});
}

function touchBinding(match,pending) {
  return canonicalToken({record:match.record,turn:match.turn,positions:[...match.positions],
    conditions:[...match.conditions],triangles:[...match.triangles],waits:[...match.waits],
    battles:match.pendingBattles,side:pending.side,pokemon:pending.pokemon,choices:pending.choices});
}

function logMatchEvent(match, event, details = {}) {
  console.log(`MATCH_EVENT ${JSON.stringify({
    schema: "kiwi-duel-owned-match-event-1",
    match_id: match.id,
    event,
    turn: match.turn,
    move_count: match.record.all_moves.length,
    ...details,
  })}`);
}

// A PlayGame record contains the exact user-adjusted wheel ranges, damage,
// MP, evolution slots, and plate loadout used by the native engine.  Recover
// those authored values from the empty, pre-move reference record rather than
// fabricating a generic wheel for every figure.  makeRecord() replaces every
// captured identity and all per-match state before this data reaches a client.
const referenceDocument = JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/reference_match_record.json", import.meta.url)),
  "utf8",
));
const figureMasterDocument = JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/figure_master_map.json", import.meta.url)),
  "utf8",
));
const figureBattleMasterDocument = JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/figure_battle_master_map.json", import.meta.url)),
  "utf8",
));
const FIELD_POINT_Z = fieldPointZFromTable(JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/match_stage_contract.json", import.meta.url)), "utf8",
)).table);
const referenceFigureContract = JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/reference_match_figure_contract.json", import.meta.url)),
  "utf8",
));
const pokepower1227Contract = JSON.parse(readFileSync(
  fileURLToPath(new URL("../data/reference_match_pokepower_1227_contract.json", import.meta.url)),
  "utf8",
));
const MATCH_RECORD_TEMPLATE = referenceDocument.record;

function assertEvidenceTemplate() {
  if (!MATCH_RECORD_TEMPLATE || !Array.isArray(MATCH_RECORD_TEMPLATE.players) || MATCH_RECORD_TEMPLATE.players.length !== 2) {
    throw new Error("reference_match_record_players_invalid");
  }
  for (const [playerIndex, player] of MATCH_RECORD_TEMPLATE.players.entries()) {
    if (!Array.isArray(player.pokemons) || player.pokemons.length !== 6) {
      throw new Error(`reference_match_record_deck_invalid_${playerIndex}`);
    }
    for (const pokemon of player.pokemons) {
      const totalRange = (pokemon.skills || []).reduce((total, skill) => total + Number(skill.range || 0), 0);
      if (totalRange <= 0) throw new Error(`reference_match_record_wheel_invalid_${pokemon.pokemon_index}`);
    }
  }
}

assertEvidenceTemplate();

const DECKS = MATCH_RECORD_TEMPLATE.players.map((player) => player.pokemons.map((pokemon) => {
  const master = figureMasterDocument.figures?.[String(Number(pokemon.id))] || {};
  const captured = referenceFigureContract.figures?.[String(Number(pokemon.id))] || {};
  return {
    itemMasterId: Number(pokemon.id),
    modelId: Number(master.model_id ?? -1),
    mp: Number(pokemon.mp),
    figureNumber: Number(captured.figure_number ?? master.figure_no ?? -1),
    rarity: captured.rarity == null ? null : Number(captured.rarity),
  };
}));
const DECK = DECKS[0];
const PLATE_IDS = MATCH_RECORD_TEMPLATE.players[0].plates.map(Number);
const MATCH_PLATE_IDS = [...new Set(MATCH_RECORD_TEMPLATE.players.flatMap((player) => player.plates.map(Number)))];

function graph() {
  const result = new Map();
  const add = (from, to) => {
    if (!result.has(from)) result.set(from, []);
    if (!result.has(to)) result.set(to, []);
    result.get(from).push(to);
    result.get(to).push(from);
  };
  for (const [from, to] of FIELD_EDGES) add(from, to);
  for (let bench = 28; bench < 34; bench += 1) {
    add(bench, 21);
    add(bench, 27);
  }
  for (let bench = 34; bench < 40; bench += 1) {
    add(bench, 0);
    add(bench, 6);
  }
  return result;
}

const BOARD_GRAPH = graph();

function sideForPokemon(index) {
  return index < 6 ? "black" : "white";
}

function otherSide(side) {
  return side === "white" ? "black" : "white";
}

function makeRecord(matchId) {
  const record = clone(MATCH_RECORD_TEMPLATE);
  record.ai_protocol_version = "custom.2";
  record.all_moves = [];
  record.client_ai_name = "kiwi-duel-local";
  record.first_player = "black";
  record.first_seed = 1;
  record.gym_additions = [];
  record.id = String(matchId);
  record.logs = null;
  record.remaining_turns = 300;
  record.seed = 1;
  record.seeds = [1];
  record.server_ai_name = "kiwi-duel-opponent";
  record.players[0].id = String(LOCAL_USER_ID);
  record.players[0].color = "black";
  record.players[1].id = String(OPPONENT_USER_ID);
  record.players[1].color = "white";
  return record;
}

function recordDeck(record, playerIndex) {
  return (record.players?.[playerIndex]?.pokemons || []).map((pokemon) => {
    const master = figureMasterDocument.figures?.[String(Number(pokemon.id))] || {};
    const captured = referenceFigureContract.figures?.[String(Number(pokemon.id))] || {};
    return {
      itemMasterId: Number(pokemon.id),
      modelId: Number(master.model_id ?? -1),
      mp: Number(pokemon.mp),
      figureNumber: Number(captured.figure_number ?? master.figure_no ?? -1),
      rarity: captured.rarity == null ? null : Number(captured.rarity),
    };
  });
}

function pokemonFromBattleMaster(master, pokemonIndex) {
  if (!master || !master.playable || Number(master.wheel_range) !== 96) throw new Error("battle_figure_master_invalid");
  return {
    direct_evolution: false,
    evolution: -1,
    form_index: pokemonIndex,
    id: Number(master.item_master_id),
    mp: Number(master.mp),
    pokemon_index: pokemonIndex,
    pokepower: Number(master.pokepower_id ?? -1),
    skills: (master.skills || []).map((skill) => ({
      color: Number(skill.color),
      id: Number(skill.skill_master_id),
      range: Number(skill.range),
      speed_or_damage: Number(skill.color) === 2 ? Number(skill.star ?? 0) : Number(skill.power ?? 0),
    })),
  };
}

function applySelectedDeck(record, selectedDeck, playerIndex = 0) {
  if (!selectedDeck) return record;
  if (!Array.isArray(selectedDeck.figures) || selectedDeck.figures.length !== 6) throw new Error("battle_deck_requires_six_figures");
  const figures = selectedDeck.figures.map((entry, index) => {
    const master = figureBattleMasterDocument.figures?.[String(Number(entry.item_master_id))];
    if (!master) throw new Error(`battle_figure_master_missing_${Number(entry.item_master_id)}`);
    return pokemonFromBattleMaster(master, playerIndex * 6 + index);
  });
  const plates = (selectedDeck.plates || []).map(Number);
  record.players[playerIndex].pokemons = figures;
  record.players[playerIndex].plates = plates;
  return record;
}

function applyBattleEvidenceRecord(record, mode) {
  if (mode !== "native_bridge_1227_speedup_once") return record;
  const defender = clone(pokepower1227Contract.defender);
  const attacker = clone(pokepower1227Contract.attacker);
  defender.pokemon_index = 0;
  defender.form_index = 0;
  attacker.pokemon_index = 6;
  attacker.form_index = 6;
  record.players[0].pokemons[0] = defender;
  record.players[1].pokemons[0] = attacker;
  return record;
}

function ensurePlateState(match) {
  const equipment = equippedPlateBinding(match.record);
  if (match.plateState && JSON.stringify(match.plateState.equipment) !== JSON.stringify(equipment)) {
    if (match.record.all_moves.length) throw new Error("plate_equipment_changed_after_start");
    match.plateState = null;
  }
  if (!match.plateState) {
    // Human pairing replaces the provisional white deck before first playgame.
    // Never silently reconstruct a resumed nonempty plate history as unused.
    if (match.record.all_moves.some((move) => moveType(move) === "declare_plate")) {
      throw new Error("plate_state_missing_for_record_prefix");
    }
    match.plateState = createPlateState(match.record);
  }
  return match.plateState;
}

function plateStateSnapshot(match) {
  const state = ensurePlateState(match);
  return {
    schema: 1,
    match_id: String(match.record.id),
    record_move_count: match.record.all_moves.length,
    equipped: clone(state.equipment),
    plate_conditions: plateConditionsSnapshot(state),
    attachments: plateAttachmentSnapshot(state).map(attachment => {
      if (sphereAttachmentSuppressed(match.positions, state, attachment, FIELD_EDGES)) delete attachment.effect.charge_effect;
      return attachment;
    }),
    pending_selection: match.pendingPlate ? {
      side: match.pendingPlate.side, plate_id: match.pendingPlate.plateId,
      pokemon: match.pendingPlate.pokemon,
      ...(match.pendingRespin ? { respin: true, declared: Boolean(match.pendingRespin.declared) } : {}),
    } : {},
    diagnostics: {
      authority: "owned_supported_plate_subset",
      full_native_fidelity: false,
      unresolved_transitions: clone(state.unresolved_transitions),
    },
  };
}

// Owned adapter state, not an extra field in the original Kaeru protocol.
// Keep the immutable definition binding separate from the temporary wheel.
function zFigureBinding(record) {
  return ["black", "white"].map(color => ({ color, pokemons: (record.players || [])
    .find(player => player.color === color)?.pokemons.slice()
    .sort((a, b) => a.pokemon_index - b.pokemon_index).map(pokemon => Number(pokemon.id)) || [] }));
}

function ensureZState(match) {
  const figures = zFigureBinding(match.record);
  if (match.zFigures && JSON.stringify(figures) !== JSON.stringify(match.zFigures)) {
    if (match.record.all_moves.length) throw new Error("z_figures_changed_after_start");
    match.zState = null;
  }
  if (!match.zState) {
    if (match.record.all_moves.some(move => moveType(move) === "z_skill")) {
      throw new Error("z_state_missing_for_record_prefix");
    }
    match.zState = createZTransactionState();
    match.zFigures = figures;
  }
  return match.zState;
}

function zChoices(match) {
  const state = ensureZState(match);
  const result = deriveZChoices(match.record, {
    side: match.turn, gauges: match.zGauge, positions: match.positions,
    waits: match.waits, conditions: match.conditions,
    phaseAllowed: match.phase === "started" && !state.active && !match.pendingPlate
      && !match.pendingGrudge && !match.pendingTouch && !match.pendingRespin && !match.pendingKnockouts && !match.battleResolutionPending
      && match.pendingBattles.length === 0,
    supportedSkillIds: [1715, 1717],
  });
  // A move cannot be advertised if one of this turn's reachable targets could
  // require an unimplemented outcome. Reject before selection: otherwise a
  // move onto an occupied target would trap a selected Z transaction. This is
  // an explicit owned capability boundary, not an original eligibility rule.
  result.choices = result.choices.filter(action => {
    const active = action.value;
    if (active.dst_skill_id !== 1715) return true;
    const actor = active.pokemon, side = sideForPokemon(actor);
    const destinations = new Set([match.positions.get(actor), ...legalRoutes(match, side, { allowedPokemon: actor })
      .map(move => movementRoute(move).at(-1))]);
    const failures = [];
    for (const [target, point] of match.positions) {
      if (sideForPokemon(target) === side || point < 0 || point >= 28) continue;
      if (![...destinations].some(destination => destination === point || (BOARD_GRAPH.get(destination) || []).includes(point))) continue;
      const capability = zBattleCapability(match, actor, target, active);
      if (!capability.ok) failures.push({ code: capability.code, pokemon: actor, target_pokemon: target,
        dst_skill_id: active.dst_skill_id, opponent_skill_ids: capability.skill_ids });
    }
    result.diagnostics.push(...failures);
    return failures.length === 0;
  });
  return result;
}

function zBattleCapability(match, attacker, defender, active = ensureZState(match).active) {
  if (active?.pokemon !== attacker || active?.dst_skill_id !== 1715) return { ok: true };
  const wheel = (pokemonDefinition(match, defender)?.skills || []).filter(skill => Number(skill.range) > 0);
  const unsupported = wheel.filter(skill => Number(skill.color) === 4
    || (Number(skill.color) === 2 && Number(skill.speed_or_damage) >= active.speed_or_damage));
  if (!unsupported.length) return { ok: true };
  const code = unsupported.some(skill => Number(skill.color) === 4) ? "z1715_blue_response_unproven"
    : unsupported.some(skill => Number(skill.speed_or_damage) === active.speed_or_damage) ? "z1715_draw_unproven"
    : "z1715_non_gold_loss_unproven";
  return { ok: false, code, skill_ids: unsupported.map(skill => Number(skill.id)) };
}

function zStateSnapshot(match) {
  const state = ensureZState(match);
  const choices = zChoices(match);
  return {
    schema: 1, match_id: String(match.record.id), record_move_count: match.record.all_moves.length,
    figures: clone(match.zFigures), active: copyZTransactionState(state).active,
    legal_actions: choices.choices, supported_skill_ids: [1715, 1717],
    diagnostics: { authority: "owned_supported_z_subset", full_native_fidelity: false,
      unresolved_transitions: choices.diagnostics },
  };
}

function makePlayGame(match) {
  return {
    ServerSendIndex: -1,
    ServerRecvIndex: -1,
    ClientRecvIndex: -1,
    Record: clone(match.record),
    PlateState: plateStateSnapshot(match),
    ZState: zStateSnapshot(match),
    IsGoAborted: false,
    GoCallTurn: false,
    GoRemainTurn: 0,
    DisplayInfo: "",
    WhiteMilliSecondsTimeLimit: match.whiteTimeMs,
    BlackMilliSecondsTimeLimit: match.blackTimeMs,
    ZGaugeConditions: [
      { color: "black", z_gauge: Number(match.zGauge?.black || 0) },
      { color: "white", z_gauge: Number(match.zGauge?.white || 0) },
    ],
    LocalAiJson: "",
  };
}

function splitCommand(line) {
  const splitAt = line.indexOf(" ");
  return splitAt < 0
    ? { command: line, payload: "" }
    : { command: line.slice(0, splitAt), payload: line.slice(splitAt + 1) };
}

function normalizeMove(move) {
  if (!move || typeof move !== "object" || Array.isArray(move)) return null;
  const side = String(move.selective_side ?? move.SelectiveSide ?? "").toLowerCase();
  const value = move.value ?? move.Value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { display_info: String(move.display_info ?? move.DisplayInfo ?? "move"), selective_side: side, value: clone(value) };
}

function moveType(move) {
  return String(move?.value?.type ?? move?.value?.Type ?? "");
}

function movementRoute(move) {
  const value = move?.value ?? {};
  const route = value.route ?? value.Route;
  return Array.isArray(route) ? route.map(Number) : [];
}

function sameRoute(left, right) {
  return left.length === right.length && left.every((point, index) => point === right[index]);
}

function nestedPlateType(move) {
  const nested = move?.value?.value ?? move?.value?.Value;
  return String(nested?.type ?? nested?.Type ?? "");
}

function moveEndsTurn(move, opponentOccupiedDestination = false) {
  const type = moveType(move);
  if (type === "spot_move") return true;
  if (type === "mp_move") return !opponentOccupiedDestination;
  if (["spin", "null_move", "declare_turn_end", "resign", "touch"].includes(type)) return true;
  if (["declare_battle", "declare_respin", "route_move", "battle_info", "battle_result"].includes(type)) return false;
  if (type === "declare_plate") return ["spot_move", "swap_move"].includes(nestedPlateType(move))
    || SUPPORTED_SPHERE_IDS.includes(move.value.plate_id) && nestedPlateType(move) === 'select_pokemon_and_declare_aura';
  return false;
}

function pokemonAtPoint(match, point) {
  for (const [index, current] of match.positions.entries()) {
    if (current === point) return index;
  }
  return -1;
}

function pokemonForSideAtPoint(match, point, side) {
  for (const [index, current] of match.positions.entries()) {
    if (current === point && sideForPokemon(index) === side) return index;
  }
  return -1;
}

function pokemonDefinition(match, pokemonIndex) {
  for (const player of match.record.players || []) {
    const found = (player.pokemons || []).find((pokemon) => Number(pokemon.pokemon_index) === Number(pokemonIndex));
    if (found) return found;
  }
  return null;
}

function selectedSkill(match, pokemonIndex, rangeUnit, displace = 0, colorActions = null) {
  if (!Number.isInteger(rangeUnit) || rangeUnit < 0 || !Number.isSafeInteger(displace)) return null;
  const active = ensureZState(match).active;
  if (active?.pokemon === pokemonIndex && Number.isInteger(rangeUnit) && rangeUnit >= 0 && rangeUnit < 96) {
    const effective = effectiveZSkill(active);
    return { id: effective.id, range: effective.range, speed_or_damage: effective.speed_or_damage,
      color: Number(effective.skill_master.SkillColor),
      // Roulette.SetZSkill overrides the master FormatType (1717 stores0).
      format: Number(effective.skill_master.SkillColor) === 4 ? 0 : 1, z_skill: true };
  }
  const pokemon = pokemonDefinition(match, pokemonIndex);
  // Original Roulette.SetSkillData removes zero-width pieces before its
  // RangeToSkillNumber + Displace modulo calculation.
  const skills = (pokemon?.skills || []).filter(skill => Number(skill.range) > 0);
  let cumulative = 0;
  for (const [index, skill] of skills.entries()) {
    cumulative += Math.max(0, Number(skill.range) || 0);
    if (cumulative > rangeUnit) {
      const target = ((index + displace) % skills.length + skills.length) % skills.length;
      const selected = clone(skills[target]);
      const disabled = match.disabledSkills?.get(pokemonIndex);
      if (disabled?.has(Number(selected.id))) {
        selected.id = 1131;
        selected.color = 0;
        selected.speed_or_damage = 0;
        selected.disabled_replacement = true;
        selected.paralysis_replacement = match.conditions.get(pokemonIndex) === "paralyze";
        return selected;
      }
      const printedDamage = Number(selected.speed_or_damage || 0);
      applyBattleColorActions(pokemonIndex, selected, colorActions
        ?? battleColorActions(match.record, match.positions, match.battledAfterField, pokemonIndex, -1, FIELD_EDGES, match.turn));
      if ([1, 3].includes(Number(selected.color))) {
        selected.printed_damage = printedDamage;
        selected.x_attack_bonus = selected.printed_damage > 0 ? Number(match.damageBonuses.get(pokemonIndex) || 0) : 0;
        selected.speed_or_damage = Number(selected.speed_or_damage || 0) + selected.x_attack_bonus;
      }
      return selected;
    }
  }
  return null;
}

// These FormatType3 masters share the exact original repeated-hit rule.
// Starred attacks with additional effects remain separate catalog entries.
const REPEATED_HIT_SKILLS = new Set([1168, 1172, 1201, 1261, 1273, 1310, 1361, 1369, 1596]);
// Separate native hit/miss traces establish one retry, even on a 100% wheel.
const SINGLE_RETRY_SKILLS = new Map([[1283, 50], [1301, 20], [1307, 50], [1492, 50], [1533, 50], [1676, 0]]);
// Native witnesses establish each primary-effect family. Additional IDs have
// identical Purple FormatType0 descriptions and per-variant tests. This does
// not establish immunity, replacement or later-turn condition behavior.
const PURPLE_STATUS_ATTACKS = new Map([[1009, "panic"], [1063, "panic"], [1070, "panic"],
  [1018, "sleep"], [1039, "sleep"], [1064, "sleep"], [1085, "sleep"], [1318, "sleep"], [1020, "sleep"],
  [1023, "burn"], [1024, "burn"], [1106, "burn"], [1045, "paralyze"], [1071, "paralyze"], [1103, "paralyze"],
  [1073, "poison"], [1074, "poison"], [1077, "poison"], [1078, "poison"], [1075, "bad_poison"], [1076, "bad_poison"], [1319, "freeze"]]);

function selectedSpinSkill(match, pokemon, results, colorActions = null) {
  let selected = null;
  for (const result of results || []) {
    const skill = selectedSkill(match, pokemon, Number(result.num), Number(result.displace ?? 0), colorActions);
    if (result.type === "battle") {
      selected = skill;
      if (selected && REPEATED_HIT_SKILLS.has(Number(selected.id))) {
        selected.repeat_extra_hits = 0;
        selected.repeat_multiplicand = Number(selected.speed_or_damage) - Number(selected.x_attack_bonus || 0);
      }
      if (selected && SINGLE_RETRY_SKILLS.has(Number(selected.id))) selected.single_retry_seen = false;
    } else if (result.type === "probability" && selected && REPEATED_HIT_SKILLS.has(Number(selected.id))) {
      if (Number(skill?.id) === Number(selected.id)) {
        selected.repeat_extra_hits += 1;
        selected.speed_or_damage += selected.repeat_multiplicand;
      }
    } else if (result.type === "probability" && selected && SINGLE_RETRY_SKILLS.has(Number(selected.id)) && !selected.single_retry_seen) {
      selected.single_retry_seen = true;
      if (Number(skill?.id) === Number(selected.id)) {
        const bonus = Number(selected.id) === 1676
          ? Number(selected.speed_or_damage) - Number(selected.x_attack_bonus || 0)
          : SINGLE_RETRY_SKILLS.get(Number(selected.id));
        selected.speed_or_damage += bonus;
      }
    }
  }
  return selected;
}

function latestBattleSpinResults(match) {
  const results = new Map();
  for (let i = match.record.all_moves.length - 1; i >= 0; i--) {
    const value = match.record.all_moves[i].value;
    if (value.type === "declare_battle") break;
    if (value.type === "spin") for (const spin of value.spins) {
      if (spin.results.some(result => result.type === "battle") && !results.has(Number(spin.pokemon))) results.set(Number(spin.pokemon), spin.results);
    }
  }
  return results;
}

function conditionSpinDisplacement(condition) {
  // ConditionDescription.panic: shift one segment clockwise. The original
  // client adds the signed wire displacement to the filtered segment index.
  // The panic-specific native sign/secondary interactions remain unobserved.
  return condition === "panic" ? 1 : 0;
}

function rollBattleWheel(match, pokemon, spinUnitSource, observedUnit) {
  const range = wheelRange(match, pokemon);
  const draw = () => {
    const unit = spinUnitSource(range, pokemon);
    if (!Number.isInteger(unit) || unit < 0 || unit >= range) throw new Error("invalid_spin_rng_result");
    return unit;
  };
  const initial = observedUnit ?? draw();
  const displace = conditionSpinDisplacement(match.conditions.get(pokemon));
  const results = [{displace, num: initial, type: "battle"}];
  const skill = selectedSkill(match, pokemon, initial, displace);
  if (SINGLE_RETRY_SKILLS.has(Number(skill?.id))) {
    results.push({displace, num: draw(), type: "probability"});
  } else if (REPEATED_HIT_SKILLS.has(Number(skill?.id))) {
    for (;;) {
      // Transport/resource guard: fail before publishing anything, never invent
      // a terminating Miss or resolve an unfinished repeated-hit sequence.
      if (results.length >= 1024) throw new Error("repeated_spin_resource_limit");
      const num = draw(); results.push({displace, num, type: "probability"});
      if (Number(selectedSkill(match, pokemon, num, displace)?.id) !== Number(skill.id)) break;
    }
  }
  return {pokemon, results};
}

function iceShardSpinPlans(match, attacker, defender, left, right) {
  const plans = [];
  for (const [pokemon, skill, opposing] of [[attacker, left, right], [defender, right, left]]) {
    if (Number(skill?.id) !== 1001 || Number(opposing?.color) === 4) continue;
    // Native Psychic Surge controls: White Ice Shard loses its production
    // against a winning Purple effect, including Fly and Double Flight. A
    // damage loss against White/Gold still triggers the secondary Spin.
    if (Number(skill.color) === 1 && Number(opposing?.color) === 2) continue;
    const nearby = new Set([match.positions.get(pokemon)]);
    for (let distance = 0; distance < 2; distance++) {
      for (const point of [...nearby]) for (const next of [...(BOARD_GRAPH.get(point) || [])].sort((a,b)=>a-b)) {
        if(next>=0&&next<28)nearby.add(next);
      }
    }
    // Original legal histories and three/four-target controls retain board
    // breadth-first order at declaration, then reverse it for field Spin.
    const occupants=new Map([...match.positions].map(([target,point])=>[point,target]));
    const targets=[...nearby].filter(point=>occupants.has(point)
      &&sideForPokemon(occupants.get(point))!==sideForPokemon(pokemon)).map(point=>occupants.get(point));
    if (targets.length) plans.push({pokemon, skill:1001, targets});
  }
  return plans;
}

// Rule RNG callbacks receive (range, pokemon); crypto.randomInt has a
// different two-argument signature. Keep the context argument out of it.
function randomWheelIndex(range) { return randomInt(range); }

function smallestAttackIds(pokemon) {
  const sizes = new Map();
  for (const skill of pokemon?.skills || []) {
    const id = Number(skill.id), range = Number(skill.range);
    if (![1, 2, 3, 4].includes(Number(skill.color)) || !Number.isSafeInteger(id)
        || !Number.isSafeInteger(range) || range <= 0) continue;
    sizes.set(id, (sizes.get(id) || 0) + range);
  }
  const minimum = Math.min(...sizes.values());
  return [...sizes].filter(([, range]) => range === minimum).map(([id]) => id);
}

function paralysisDisabledSkill(match, pokemonIndex, choiceSource = randomWheelIndex) {
  if (match.conditions.get(pokemonIndex) !== "paralyze") return -1;
  return smallestDisabledAttack(match, pokemonIndex, choiceSource);
}

function smallestDisabledAttack(match, pokemonIndex, choiceSource = randomWheelIndex) {
  // The official guide specifies the smallest Attack. Native item1433's
  // selected Purple1590 proves split Blue1591 segments count together.
  // Ties select one Attack; test injection does not claim native RNG parity.
  const candidates = smallestAttackIds(pokemonDefinition(match, pokemonIndex));
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];
  const choice = choiceSource(candidates.length, pokemonIndex);
  if (!Number.isInteger(choice) || choice < 0 || choice >= candidates.length) throw new Error("invalid_condition_choice_rng_result");
  return candidates[choice];
}

function conditionDisabledSkills(match, pokemonIndex, choiceSource = randomWheelIndex) {
  if (match.conditions.get(pokemonIndex) === "burn") {
    const selected = smallestDisabledAttack(match, pokemonIndex, choiceSource);
    return selected < 0 ? [] : [selected];
  }
  if (["freeze", "melt"].includes(match.conditions.get(pokemonIndex))) {
    // Original ConditionDescription: all Attacks miss. Use the existing
    // Attack-ID array contract so split pieces and every Attack color agree
    // on both clients. Native command batching remains an evidence boundary.
    return [...new Set((pokemonDefinition(match, pokemonIndex)?.skills || [])
      .filter(skill => [1, 2, 3, 4].includes(Number(skill.color))
        && Number.isSafeInteger(Number(skill.id)) && Number(skill.range) > 0)
      .map(skill => Number(skill.id)))];
  }
  const selected = paralysisDisabledSkill(match, pokemonIndex, choiceSource);
  return selected < 0 ? [] : [selected];
}

function applyConditionBattleDamage(match, pokemon, opponent, skill) {
  if (!skill || ![1, 3].includes(Number(skill.color))) return skill;
  if (Number(skill.printed_damage ?? skill.speed_or_damage) === 0) return skill;
  // Skill damage is calculated before the existing flat X Attack bonus.
  // 1621's description is conditional on paralysis, not on which segment
  // the opponent spins. Calculate it before comparing the two attacks.
  if (Number(skill.id) === 1621 && match.conditions.get(opponent) === "paralyze") {
    const plateBonus = Number(skill.x_attack_bonus ?? match.damageBonuses.get(pokemon) ?? 0);
    skill.paralysis_damage_bonus = Number(skill.speed_or_damage) - plateBonus;
    skill.speed_or_damage += skill.paralysis_damage_bonus;
  }
  applyFieldCountDamage(match.record, match.positions, pokemon, skill, Number(skill.x_attack_bonus ?? match.damageBonuses.get(pokemon) ?? 0));
  applyDamageAuras(match.record, match.positions, match.conditions, pokemon, skill, Number(skill.x_attack_bonus ?? match.damageBonuses.get(pokemon) ?? 0));
  applySphereDamage(match.record, match.positions, match.plateState, pokemon, skill, FIELD_EDGES);
  const condition = match.conditions.get(pokemon);
  const penalty = {burn: 10, poison: 20, bad_poison: 40}[condition] || 0;
  if (penalty) {
    const current = Number(skill.speed_or_damage);
    // Native arithmetic notices retain a negative intermediate; only the
    // resolved battle damage is floored at zero.
    skill.condition_damage = {condition, current, addend: -penalty, result: current - penalty};
    skill.speed_or_damage = Math.max(0, skill.condition_damage.result);
  }
  applyBattleDamageReduction(match.record,match.positions,match.conditions,pokemon,opponent,skill);
  applyFieldDamageReductions(match.record,match.positions,pokemon,opponent,skill,FIELD_EDGES);
  return skill;
}

function conditionSnapshot(match) {
  return Object.fromEntries([...match.conditions.entries()].map(([pokemon, condition]) => [String(pokemon), condition]));
}

function waitSnapshot(match) {
  return Object.fromEntries([...match.waits.entries()].map(([pokemon, wait]) => [String(pokemon), wait]));
}

function decrementWaits(match) {
  for (const [pokemon, wait] of match.waits.entries()) {
    if (wait > 0) match.waits.set(pokemon, wait - 1);
  }
}

// Raw cleanup remains a compatibility primitive for the isolated rule-math
// tests. Production completion always goes through the service coordinator.
function completeTurnCleanup(match, side) {
  const zState = ensureZState(match);
  if (zState.active) match.zState = finishZNonbattleTurn(zState, side).state;
  completePlateTurn(ensurePlateState(match), side);
  decrementWaits(match);
  match.pendingBattles = [];
  match.battleResolutionPending = false;
  match.pendingPlate = null;
  match.pendingRespin = null;
  match.pendingGrudge = null;
  match.pendingTouch = null;
  match.pendingKnockouts = null;
  match.pendingSecondarySpins = null;
  match.pendingJump = null;
  match.pendingExtraBattle = null;
  match.extraBattle = null;
  match.damageBonuses.clear();
  match.disabledSkills.clear();
  match.turns[side] += 1;
  match.turn = otherSide(side);
}

function completionKind(move) {
  const type = moveType(move);
  if (type === "spot_move") return "nonbattle_spot_move";
  if (type === "mp_move") return "nonbattle_mp_move";
  if (["null_move", "declare_turn_end", "touch"].includes(type)) return type;
  if (type === "declare_plate" && moveEndsTurn(move)) return "turn_ending_plate";
  return null;
}

function checkedTurnRecord(match, additionalMove = null) {
  // Human pairing can replace definitions after createMatch. Bind only while
  // the actual record is empty, before its first accepted append; never create
  // ordinal zero over an existing unaccounted history.
  const current = match.completedTurnLedger == null ? createLedger(match.record)
    : inspectLedger(match.completedTurnLedger, match.record);
  if (!current.ok) return current;
  if (additionalMove == null) return { ok: true, state: current.state, record: match.record };
  // Canonical validation must precede reading/cloning properties of a proposed
  // move; malformed/accessor-bearing trusted test input is not repaired here.
  const record = { ...match.record, all_moves: [...match.record.all_moves, additionalMove] };
  const verified = inspectLedger(current.state, record);
  return verified.ok ? { ok: true, state: current.state, record } : verified;
}

function plannedTurnCompletion(match, side, kind, actionRecordIndex, additionalMove = null) {
  const checked = checkedTurnRecord(match, additionalMove);
  if (!checked.ok) return checked;
  const proposal = proposeCompletion(checked.record, { schema: FACT_SCHEMA,
    ordinal: checked.state.completed_turns + 1, kind, ended_side: side,
    action_record_index: actionRecordIndex, record_move_count: checked.record.all_moves.length,
    finalized: true, pending_choice: false, pending_callbacks: 0 });
  if (!proposal.ok) return proposal;
  const committed = commitCompletion(checked.state, proposal.cause, checked.record);
  return committed.ok ? { ok: true, cause: proposal.cause } : committed;
}

function completionFailure(match, reason) {
  console.error(`MATCH_COMPLETION_REJECTED ${JSON.stringify({ schema: "kiwi-completed-turn-rejection-1",
    match_id: String(match.id), reason, move_count: Array.isArray(match.record?.all_moves) ? match.record.all_moves.length : null })}`);
  return false;
}

function turnRuleProjection(match) {
  return { ...match, zState: match.zState ? structuredClone(match.zState) : null,
    plateState: match.plateState ? structuredClone(match.plateState) : null,
    positions: new Map(match.positions), conditions: new Map(match.conditions), waits: new Map(match.waits),
    triangles: new Map(match.triangles),
    battledAfterField: new Map(match.battledAfterField),
    turns: { ...match.turns }, damageBonuses: new Map(match.damageBonuses),
    disabledSkills: new Map([...match.disabledSkills].map(([pokemon, ids]) => [pokemon, new Set(ids)])) };
}

function validateTurnCleanup(match, side, additionalMove = null, battle = null) {
  const projected = turnRuleProjection(match);
  const zState = copyZTransactionState(ensureZState(projected));
  const plates = ensurePlateState(projected);
  if (moveType(additionalMove) === "declare_plate") applyPlateDeclaration(plates, additionalMove, match.record.all_moves.length);
  if (battle) completePlateBattle(plates, battle);
  completePlateTurn(plates, side);
  // A resolving Z needs its actual battle facts, checked separately on the
  // projected outcome. This preliminary check never pretends it is nonbattle.
  if (zState.active && zState.active.phase !== "resolving") finishZNonbattleTurn(zState, side);
  decrementWaits(projected);
  projected.damageBonuses.clear(); projected.disabledSkills.clear();
  return projected;
}

function completionCapacityAvailable(match, additionalMove = null, reservedMoves = 64) {
  // Storage/encoder safety headroom, not a new gameplay turn rule. The owned
  // 12-figure paths need at most 12 KO inputs + 12 shifts + 12 KO gauges,
  // 2 disables, 2 spins, declaration/respin/plate/MP and 3 settlement gauges
  // (<64 records). Each generated record is smaller/shallower than this
  // 128-integral + 1KiB placeholder; it is validated only, never appended.
  // Checking the whole padded value also reserves canonical node/byte limits.
  try {
    const reserve = { nodes: Array(128).fill(9007199254740991), bytes: "x".repeat(1024) };
    canonicalToken({ ...match.record, all_moves: [...match.record.all_moves,
      ...(additionalMove ? [additionalMove] : []), ...Array(reservedMoves).fill(reserve)] });
    return true;
  } catch (error) { return completionFailure(match, `completion_capacity:${error.message}`); }
}

function wheelRange(match, pokemonIndex) {
  if (ensureZState(match).active?.pokemon === pokemonIndex) return 96;
  return (pokemonDefinition(match, pokemonIndex)?.skills || [])
    .reduce((total, skill) => total + Math.max(0, Number(skill.range) || 0), 0);
}

function currentBattleResolution(match, state, phase) {
  const pending = match.activeBattleResolution;
  return match.phase === "started" && pending?.phase === phase
    && match.turn === (state.turnSide ?? state.attackingSide) && pending.side === state.attackingSide
    && (pending.turnSide ?? pending.side) === (state.turnSide ?? state.attackingSide)
    && pending.attacker === state.attacker && pending.defender === state.defender
    && pending.attackerUnit === state.attackerUnit && pending.defenderUnit === state.defenderUnit
    && Number.isSafeInteger(state.spinRecordIndex) && pending.spinRecordIndex === state.spinRecordIndex
    && moveType(match.record.all_moves[state.spinRecordIndex]) === "spin";
}

function baseSkillWinner(left, right) {
  if (!left || !right) return -1;
  // FigureSkillMaster color ids recovered by the original client are:
  // 0 Miss, 1 White, 2 Purple, 3 Gold, 4 Blue.  This is the exact priority
  // table stated in the preserved in-game battle tips and mirrored by the
  // native-engine conformance fixtures used by MatchMovePlanner.
  const leftColor = Number(left.color) || 0;
  const rightColor = Number(right.color) || 0;
  if (leftColor === 4 || rightColor === 4) {
    if (leftColor === rightColor) return -1;
    return leftColor === 4 ? 0 : 1;
  }
  if (leftColor === 0 || rightColor === 0) {
    if (leftColor === rightColor) return -1;
    return leftColor === 0 ? 1 : 0;
  }
  if (leftColor === 2 || rightColor === 2) {
    if (leftColor === rightColor) {
      const leftStars = Number(left.speed_or_damage) || 0;
      const rightStars = Number(right.speed_or_damage) || 0;
      return leftStars === rightStars ? -1 : leftStars > rightStars ? 0 : 1;
    }
    if (leftColor === 3 || rightColor === 3) return leftColor === 3 ? 0 : 1;
    return leftColor === 2 ? 0 : 1;
  }
  const leftDamage = Number(left.speed_or_damage) || 0;
  const rightDamage = Number(right.speed_or_damage) || 0;
  return leftDamage === rightDamage ? -1 : leftDamage > rightDamage ? 0 : 1;
}

function applyPokepower1326(match, attacker, defender, battledBefore) {
  for (const owner of [attacker, defender]) {
    if (Number(pokemonDefinition(match, owner)?.pokepower) !== 1326 || battledBefore[owner]) continue;
    const opponent = owner === attacker ? defender : attacker;
    const point = Number(match.positions.get(opponent));
    if (!Number.isInteger(point) || point < 0 || point >= 28) continue;
    if (!conditionImmunitySources(match.record, match.positions, opponent, "paralyze", FIELD_EDGES).length) {
      match.conditions.set(opponent, "paralyze");
    }
    applyWait(match.record,match.waits,opponent, 3);
  }
  // Native battled_after_field_in marks surviving participants after effects.
  // Track every figure, including one which may later change its ability.
  for (const pokemon of [attacker, defender]) {
    const point = match.positions.get(pokemon);
    if (point >= 0 && point < 28 && match.conditions.get(pokemon) !== "faint") match.battledAfterField.set(pokemon, true);
  }
}

function applyRockSlide1140(match, attacker, defender, left, right, winnerSlot) {
  // The hash-bound two-role native matrix proves this is an effect on each
  // resolving Rock Slide, including a draw, not a universal knockout/PC Wait.
  // The effect is suppressed when its wheel result loses (including to Blue).
  // Native adjacent-win proves opposing figures next to the battle opponent
  // are included, while an emitter-side neighbor is excluded. Resolve targets
  // before ordinary KO changes the opponent's position to its Center slot.
  // The native re-hit preserves already-Wait targets as faint/on-field until
  // its server-owned knockedout_move continuation. Do not move them here:
  // a faint defender's simultaneously resolved Rock Slide still takes effect.
  const fainted = new Set();
  const beforeConditions = new Map(match.conditions);
  for (const [slot, target, skill, emitter] of [[0, defender, left, attacker], [1, attacker, right, defender]]) {
    if (Number(skill.id) === 1140 && (winnerSlot < 0 || winnerSlot === slot)) {
      const point = match.positions.get(target);
      const neighbors = new Set(BOARD_GRAPH.get(point) || []);
      const targets = [];
      for (const [pokemon, candidatePoint] of match.positions) {
        if (sideForPokemon(pokemon) !== sideForPokemon(target) || candidatePoint < 0 || candidatePoint >= 28) continue;
        if (pokemon === target || neighbors.has(candidatePoint)) targets.push(pokemon);
      }
      for (const pokemon of targets) {
        if (Number(match.waits.get(pokemon) || 0) > 0
            && !effectKnockoutProtectionSources(match.record, match.positions, beforeConditions, pokemon, emitter, match.turn, FIELD_EDGES).length) {
          fainted.add(pokemon);
          match.conditions.set(pokemon, "faint");
        }
      }
      for (const pokemon of targets) applyWait(match.record,match.waits,pokemon, 3);
    }
  }
  return [...fainted];
}

function planKnockoutRelocations(match, targets, { requireFaint = true } = {}) {
  const projected = new Map(match.positions);
  const occupied = [...projected.values()].filter(point => point >= 0);
  if (new Set(occupied).size !== occupied.length || new Set(targets.map(target => target.pokemon)).size !== targets.length) return null;
  const steps = [];
  for (const { pokemon, from } of targets) {
    if (!Number.isInteger(pokemon) || pokemon < 0 || pokemon >= 12 || !Number.isInteger(from) || from < 0 || from >= 28
        || projected.get(pokemon) !== from || (requireFaint && match.conditions.get(pokemon) !== "faint")) return null;
    if (match.triangles?.get(pokemon) === "curse") {
      const excluded = 44 + pokemon;
      if ([...projected.values()].includes(excluded)) return null;
      projected.set(pokemon, excluded);
      steps.push({ pokemon, excluded });
      continue;
    }
    const upper = pokemon < 6 ? 41 : 43;
    const lower = upper - 1;
    const upperPokemon = [...projected].find(([, point]) => point === upper)?.[0];
    let releasedPokemon;
    if (upperPokemon !== undefined) {
      releasedPokemon = [...projected].find(([, point]) => point === lower)?.[0];
      if (releasedPokemon !== undefined) {
        // Original MatchMain.BenchMove computes GetBench()+pokemon, not the
        // first empty slot. Native full-Center proof returns oldest0 to28.
        const bench = 28 + releasedPokemon;
        if ([...projected.values()].includes(bench)) return null;
        projected.set(releasedPokemon, bench);
      }
      projected.set(upperPokemon, lower);
    }
    projected.set(pokemon, upper);
    steps.push({ pokemon, upper, lower, upperPokemon, releasedPokemon });
  }
  return steps;
}

function applyKnockoutRelocation(match, { pokemon, excluded, upper, lower, upperPokemon, releasedPokemon }) {
  match.battledAfterField.set(pokemon, false);
  match.triangles?.set(pokemon, "empty");
  if (excluded !== undefined) {
    match.positions.set(pokemon, excluded);
    match.conditions.set(pokemon, "normal");
    match.waits.set(pokemon, 0);
    match.disabledSkills.delete(pokemon);
    return;
  }
  if (releasedPokemon !== undefined) {
    match.positions.set(releasedPokemon, 28 + releasedPokemon);
    match.battledAfterField.set(releasedPokemon, false);
    match.conditions.set(releasedPokemon, "normal");
    match.triangles?.set(releasedPokemon, "empty");
    // This is the native Center release Wait, independent of the incoming
    // figure's skill-specific Wait. Only later turn_end decrements it to1.
    applyWait(match.record,match.waits,releasedPokemon, 2);
    match.disabledSkills.delete(releasedPokemon);
  }
  if (upperPokemon !== undefined) match.positions.set(upperPokemon, lower);
  match.positions.set(pokemon, upper);
}

function applyPositionMove(match, move) {
  const relocate = (pokemon, destination) => {
    if (!Number.isSafeInteger(pokemon) || !match.positions.has(pokemon)
        || !Number.isSafeInteger(destination) || destination < 0 || destination >= 44) return false;
    if ([...match.positions].some(([other, point]) => other !== pokemon && point === destination)) return false;
    if (match.positions.get(pokemon) >= 28 || destination >= 28) match.battledAfterField.set(pokemon, false);
    match.positions.set(pokemon, destination);
    return true;
  };
  const type = moveType(move);
  if (["mp_move", "route_move"].includes(type)) {
    const route = movementRoute(move);
    if (route.length < 2) return;
    // Routes identify their actor by side; a battle is declared from an
    // adjacent point and never authorizes an occupied movement endpoint.
    const moveSide = String(move?.selective_side || "").toLowerCase();
    const pokemon = ["black", "white"].includes(moveSide)
      ? pokemonForSideAtPoint(match, route[0], moveSide)
      : pokemonAtPoint(match, route[0]);
    return relocate(pokemon, route.at(-1));
  }
  if (type === "spot_move") {
    const from = Number(move.value.from ?? move.value.From ?? -1);
    const to = Number(move.value.to ?? move.value.To ?? -1);
    const moveSide = String(move?.selective_side || "").toLowerCase();
    const pokemon = ["black", "white"].includes(moveSide)
      ? pokemonForSideAtPoint(match, from, moveSide)
      : pokemonAtPoint(match, from);
    return relocate(pokemon, to);
  }
  if (type !== "declare_plate") return;
  const nested = move.value.value ?? move.value.Value ?? {};
  const nestedType = String(nested.type ?? nested.Type ?? "");
  if (nestedType === "spot_move") {
    const moveSide = String(move?.selective_side || "").toLowerCase();
    const source = Number(nested.from ?? nested.From ?? -1);
    const pokemon = ["black", "white"].includes(moveSide)
      ? pokemonForSideAtPoint(match, source, moveSide)
      : pokemonAtPoint(match, source);
    return relocate(pokemon, Number(nested.to ?? nested.To));
  } else if (nestedType === "swap_move") {
    const pokemons = nested.pokemons ?? nested.Pokemons;
    if (Array.isArray(pokemons) && pokemons.length === 2) {
      const first = Number(pokemons[0]);
      const second = Number(pokemons[1]);
      const firstPoint = match.positions.get(first);
      const secondPoint = match.positions.get(second);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first === second
          || !match.positions.has(first) || !match.positions.has(second)
          || !Number.isSafeInteger(firstPoint) || !Number.isSafeInteger(secondPoint)
          || firstPoint < 0 || firstPoint >= 44 || secondPoint < 0 || secondPoint >= 44
          || firstPoint === secondPoint) return false;
      // Original SwapMove normalizes a bench destination to its recipient's
      // own slot. Native Grudge/Switch histories independently confirm this.
      match.positions.set(first, secondPoint>=28&&secondPoint<40?28+first:secondPoint);
      match.positions.set(second, firstPoint>=28&&firstPoint<40?28+second:firstPoint);
      for (const pokemon of [first,second]) if (match.positions.get(pokemon)>=28&&match.positions.get(pokemon)<40) {
        match.conditions.set(pokemon,"normal");match.triangles.set(pokemon,"empty");match.disabledSkills.delete(pokemon);
      }
      if (firstPoint >= 28 || secondPoint >= 28) {
        match.battledAfterField.set(first, false);
        match.battledAfterField.set(second, false);
      }
      return true;
    }
  } else if (nestedType === "put_circle" && String(nested.condition) === "normal") {
    const pokemons = nested.pokemons ?? nested.Pokemons;
    if (Array.isArray(pokemons)) {
      for (const pokemon of pokemons) match.conditions.set(Number(pokemon), "normal");
    }
  }
}

function pendingBattlesAfterMovement(match, side, movingPokemon, destination, occupiedOpponent, mpMove = false) {
  if (movingPokemon < 0 || destination < 0 || destination >= 28 || match.positions.get(movingPokemon) !== destination) return [];
  const targets = [];
  if (occupiedOpponent >= 0 && sideForPokemon(occupiedOpponent) !== side) targets.push(occupiedOpponent);
  const neighbors = new Set(BOARD_GRAPH.get(destination) || []);
  for (const [pokemon, point] of match.positions.entries()) {
    if (pokemon === movingPokemon || sideForPokemon(pokemon) === side || point >= 28) continue;
    if (neighbors.has(point) && !targets.includes(pokemon)) targets.push(pokemon);
  }
  const choices = targets.map((defender) => ({
    display_info: "move",
    selective_side: side,
    value: { from_pokemon: movingPokemon, to_pokemon: defender, type: "declare_battle" },
  }));
  return mpMove ? restrictPostMpBattles(match.record,match.positions,movingPokemon,BOARD_GRAPH,choices).choices : choices;
}

function pendingMpBattleMandatory(match,side) {
  const mover=latestMpMover(match.record,match.positions,side);
  return mover>=0 && restrictPostMpBattles(match.record,match.positions,mover,BOARD_GRAPH,match.pendingBattles).mandatory;
}

function validateMovement(match, side, move) {
  const route = movementRoute(move);
  const pending = match.pendingPlate;
  const options = pending?.side === side ? {
    allowedPokemon: pending.pokemon,
    ignoreFirstTurnPenalty: pending.plateId === 5426,
    mpOverride: pending.plateId === 5426 ? 2 : Number.NaN,
  } : {};
  return legalRoutes(match, side, options).some((candidate) => sameRoute(movementRoute(candidate), route));
}

function planMovementSurround(match, move) {
  const projected = { ...match, positions: new Map(match.positions), battledAfterField: new Map(match.battledAfterField),
    conditions: new Map(match.conditions), triangles: new Map(match.triangles), waits: new Map(match.waits), disabledSkills: new Map(match.disabledSkills) };
  if (!applyPositionMove(projected, move)) return { ok: false, reason: "surround_invalid_movement" };
  const entryRecovery = fieldEntryRecoveryPlan(match.record, match.positions, projected.positions, projected.conditions, projected.waits, projected.triangles);
  applyFieldEntryRecovery(projected, entryRecovery);
  const disguiseEntry = disguiseEntryTargets(match.record,match.positions,projected.positions);
  for (const pokemon of disguiseEntry) projected.triangles.set(pokemon,"bake_no_kawa");
  const plan = surroundingPlan(match.record, projected.positions, projected.conditions, FIELD_EDGES);
  if (!plan.ok) return plan;
  const steps = planKnockoutRelocations(projected, plan.targets.map(pokemon => ({pokemon, from: projected.positions.get(pokemon)})), {requireFaint: false});
  return steps ? {...plan, steps, entryRecovery, disguiseEntry, grudgeEntry:grudgeStoneEntry(match.record,match.positions,projected.positions)} : {ok: false, reason: "surround_invalid_center"};
}

function planJumpLanding(match, pending, move) {
  const projected=turnRuleProjection(match);
  if (!applyPositionMove(projected,move)) return {ok:false,reason:"invalid_jump_landing"};
  const knockoutSteps=planKnockoutRelocations(projected,(pending.conditionalKnockouts??[]).map(pokemon=>({pokemon,from:projected.positions.get(pokemon)})),{requireFaint:false});
  if (!knockoutSteps) return {ok:false,reason:"invalid_jump_knockout_disposition"};
  for (const step of knockoutSteps) {
    applyKnockoutRelocation(projected,step);projected.conditions.set(step.pokemon,"normal");projected.disabledSkills.delete(step.pokemon);
  }
  const surrounding=surroundingPlan(match.record,projected.positions,projected.conditions,FIELD_EDGES);
  if (!surrounding.ok) return surrounding;
  const steps=planKnockoutRelocations(projected,surrounding.targets.map(pokemon=>({pokemon,from:projected.positions.get(pokemon)})),{requireFaint:false});
  if(!steps)return {ok:false,reason:"surround_invalid_center"};
  for(const step of steps){applyKnockoutRelocation(projected,step);projected.conditions.set(step.pokemon,'normal');projected.disabledSkills.delete(step.pokemon);}
  applyPokepower1326(projected,pending.state.attacker,pending.state.defender,pending.outcome.battledBefore);
  const melt=[pending.state.attacker,pending.state.defender].filter(pokemon=>projected.positions.get(pokemon)>=0&&projected.positions.get(pokemon)<28&&projected.conditions.get(pokemon)==='melt');
  const recovery=melt.length?planConditionRecovery(projected,melt.map(pokemon=>[pokemon,'normal']),true):null;
  if(recovery&&!recovery.ok)return recovery;
  return {ok:true,knockoutSteps,surround:{...surrounding,steps},recovery};
}

function planConditionRecovery(match, changes, checkSurround) {
  const projected=turnRuleProjection(match);
  for(const [pokemon,condition] of changes)projected.conditions.set(pokemon,condition);
  const surrounding=checkSurround?surroundingPlan(projected.record,projected.positions,projected.conditions,FIELD_EDGES):{ok:true,targets:[],candidates:[]};
  if(!surrounding.ok)return surrounding;
  const steps=planKnockoutRelocations(projected,surrounding.targets.map(pokemon=>({pokemon,from:projected.positions.get(pokemon)})),{requireFaint:false});
  return steps?{...surrounding,changes,steps}:{ok:false,reason:'condition_recovery_invalid_center'};
}

function planDeclarationConditionRecovery(match, move) {
  const target=move.value.to_pokemon,condition=match.conditions.get(target);
  const changes=condition==='sleep'?[[target,'normal']]:['freeze','melt'].includes(condition)?[[target,'melt']]:[];
  if(!changes.length)return null;
  const plan=planConditionRecovery(match,changes,condition==='sleep');
  if(plan.ok)plan.cancelled=plan.targets.some(pokemon=>[move.value.from_pokemon,target].includes(pokemon));
  return plan;
}

function validateBattleDeclaration(match, side, move) {
  const value = move.value || {};
  if (!["black", "white"].includes(side) || match.phase !== "started" || match.turn !== side
      || match.pendingRespin || match.battleResolutionPending || move.selective_side !== side) return false;
  const attacker = value.from_pokemon;
  const defender = value.to_pokemon;
  if (!Number.isSafeInteger(attacker) || !Number.isSafeInteger(defender)
      || attacker < 0 || attacker >= 12 || defender < 0 || defender >= 12
      || sideForPokemon(attacker) !== side || sideForPokemon(defender) === side) return false;
  if (!zBattleCapability(match, attacker, defender).ok) return false;
  const source = match.positions.get(attacker);
  const target = match.positions.get(defender);
  if (![source, target].every((point) => Number.isInteger(point) && point >= 0 && point < 28)
      || Number(match.waits.get(attacker) || 0) > 0 || USE_BLOCKING_CONDITIONS.has(match.conditions.get(attacker))) return false;
  const pending = match.pendingPlate;
  if (pending && (pending.side !== side || pending.pokemon !== attacker)) return false;
  const adjacent = (BOARD_GRAPH.get(source) || []).includes(target);
  const selectedContinuation = match.pendingBattles.some((candidate) => (
    candidate.selective_side === side
    && Number(candidate.value.from_pokemon) === attacker
    && Number(candidate.value.to_pokemon) === defender
  ));
  if (match.pendingBattles.length > 0) {
    const mover=latestMpMover(match.record,match.positions,side);
    if(mover>=0 && !restrictPostMpBattles(match.record,match.positions,mover,BOARD_GRAPH,match.pendingBattles).choices.some(c=>c.value.from_pokemon===attacker&&c.value.to_pokemon===defender))return false;
    return selectedContinuation && adjacent;
  }
  // Native role-reversed prefix: declining white's optional battle ends that
  // turn, then black can attack its adjacent enemy directly without moving.
  // A pending movement/plate transaction never falls through to another actor.
  return adjacent;
}

function playerForSide(match, side) {
  return (match.record.players || []).find((player) => String(player.color).toLowerCase() === side) || null;
}

function validatePlateMove(match, side, move) {
  const value = move.value || {};
  const plateId = Number(value.plate_id);
  const nested = value.value || {};
  const nestedType = String(nested.type || "");
  const player = playerForSide(match, side);
  if (!player) return false;
  if (!Number.isSafeInteger(value.plate_id) || availablePlateCopy(ensurePlateState(match), side, plateId) < 0) return false;
  if (plateRestrictionSources(match.record, match.positions, nested, FIELD_EDGES, side, match.conditions).length) return false;
  const first = side === "black" ? 0 : 6;
  const isOwnPokemon = (pokemon) => Number.isSafeInteger(pokemon) && pokemon >= first && pokemon < first + 6;
  const isOwnPokemonOutsideCenter = (pokemon) => {
    const index = Number(pokemon);
    const point = match.positions.get(index);
    return isOwnPokemon(index) && Number.isInteger(point) && point >= 0 && point < 40;
  };
  if (plateId === 5002) {
    const pokemons = nested.pokemons;
    if (nestedType !== "put_circle" || String(nested.condition) !== "normal"
        || !Array.isArray(pokemons) || pokemons.length !== 1 || !isOwnPokemon(pokemons[0])) return false;
    const point = match.positions.get(pokemons[0]);
    return Number.isSafeInteger(point) && point >= 0 && point < 28
      && SPECIAL_CONDITIONS.has(match.conditions.get(pokemons[0]));
  }
  if ([5015, 5022].includes(plateId)) {
    return nestedType === "select_pokemon" && isOwnPokemonOutsideCenter(nested.pokemon);
  }
  if (plateId === 5426) {
    return nestedType === "select_pokemon_and_declare_aura" && isOwnPokemonOutsideCenter(nested.pokemon);
  }
  if (SUPPORTED_SPHERE_IDS.includes(plateId)) {
    return nestedType === 'select_pokemon_and_declare_aura' && isOwnPokemonOutsideCenter(nested.pokemon)
      && isSphereTarget(match.record, nested.pokemon, plateId)
      && !match.plateState.attachments.some(a => a.plate_id === plateId && a.pokemon === nested.pokemon
        && !sphereAttachmentSuppressed(match.positions, match.plateState, a, FIELD_EDGES))
      && Object.keys(nested).sort().join(',') === 'pokemon,type';
  }
  if (plateId === 5023) {
    const pokemons = nested.pokemons;
    if (nestedType !== "swap_move" || !Array.isArray(pokemons) || pokemons.length !== 2
        || Number(pokemons[0]) === Number(pokemons[1]) || !pokemons.every(isOwnPokemon)) return false;
    const points = pokemons.map((pokemon) => match.positions.get(Number(pokemon)));
    return points.every((point) => Number.isInteger(point) && point >= 0 && point < 40)
      && points.some((point) => point < 28) && planMovementSurround(match, move).ok;
  }
  if (plateId === 5026) {
    const source = Number(nested.from);
    const target = Number(nested.to);
    const movingPokemon = pokemonAtPoint(match, source);
    const targets = side === "black" ? [16, 17, 22, 19, 20, 26] : [1, 7, 8, 5, 10, 11];
    return nestedType === "spot_move" && source >= 28 && source < 40 && isOwnPokemon(movingPokemon)
      && targets.includes(target) && pokemonAtPoint(match, target) < 0 && planMovementSurround(match, move).ok;
  }
  if (plateId === 5306) {
    const source = Number(nested.from);
    const target = Number(nested.to);
    const movingPokemon = pokemonAtPoint(match, source);
    const goal = side === "black" ? 24 : 3;
    return nestedType === "spot_move" && source >= 0 && source < 28 && isOwnPokemon(movingPokemon)
      && target === goal && pokemonAtPoint(match, goal) < 0 && planMovementSurround(match, move).ok;
  }
  // Every other unrecovered condition/ability plate fails closed.
  return false;
}

function legalBenchEntryMoves(match, side, options = {}) {
  if (!["black","white"].includes(side)) return [];
  const context = movementTransitContext(match.record,match.positions,match.conditions,FIELD_EDGES,match.waits);
  const allowed = Number.isInteger(options.allowedPokemon) ? options.allowedPokemon : -1;
  const first = side === "black" ? 0 : 6, moves = [];
  for (let pokemon=first;pokemon<first+6;pokemon++) {
    if (allowed>=0 && pokemon!==allowed) continue;
    for (const to of benchSpotEntryTargets(context,pokemon)) {
      const move={selective_side:side,value:{from:match.positions.get(pokemon),to,type:"spot_move"}};
      if (planMovementSurround(match,move).ok) moves.push(move);
    }
  }
  return moves;
}

function validateBenchEntryMove(match,side,move) {
  if (moveType(move)!=="spot_move" || !Number.isSafeInteger(move.value?.from) || !Number.isSafeInteger(move.value?.to)) return false;
  const pending=match.pendingPlate;
  const options=pending ? {allowedPokemon:pending.pokemon} : {};
  return (!pending || pending.side===side) && legalBenchEntryMoves(match,side,options).some(candidate=>candidate.value.from===move.value.from && candidate.value.to===move.value.to);
}

function legalRoutes(match, side, options = {}) {
  const firstIndex = side === "black" ? 0 : 6;
  const spherePairs = flameSphereTransitPairs(match.record,match.positions,match.plateState,match.conditions,FIELD_EDGES);
  for (const pair of phantomSphereTransitPairs(match.record,match.positions,match.plateState,match.conditions,FIELD_EDGES)) spherePairs.add(pair);
  for (const pair of electroSphereTransitPairs(match.record,match.positions,match.plateState,match.waits,FIELD_EDGES)) spherePairs.add(pair);
  for (const pair of dragonSphereTransitPairs(match.record,match.positions,match.plateState,match.conditions,FIELD_EDGES)) spherePairs.add(pair);
  const sphereAbilityBlocks = darkSphereAbilityTransitBlocks(match.record,match.positions,match.plateState,FIELD_EDGES);
  for (const pair of stonySphereAbilityTransitBlocks(match.record,match.positions,match.plateState,FIELD_EDGES)) sphereAbilityBlocks.add(pair);
  const basePassage = new Set([...match.conditions].filter(([pokemon,condition])=>['freeze','sleep'].includes(condition)&&match.positions.get(pokemon)>=0&&match.positions.get(pokemon)<28).map(([pokemon])=>pokemon));
  const balloonTargets = new Set([...match.positions.keys()].filter(pokemon=>hasAirBalloonAttachment(match.plateState,pokemon)));
  const transit = balloonTargets.size || spherePairs.size || basePassage.size || hasMovementTransit(match.record,match.positions) ? movementTransitContext(match.record,match.positions,match.conditions,FIELD_EDGES,match.waits) : null;
  const occupancy = new Map();
  for (const [pokemon, point] of match.positions.entries()) {
    if (!occupancy.has(point)) occupancy.set(point, []);
    occupancy.get(point).push(pokemon);
  }
  const allowedPokemon = Number.isInteger(options.allowedPokemon) ? Number(options.allowedPokemon) : -1;
  const results = [];
  const collect = (pokemon, path, maximumSteps) => {
    if (path.length - 1 >= maximumSteps) return;
    for (const neighbor of BOARD_GRAPH.get(path.at(-1)) ?? []) {
      if (neighbor >= 28 || path.includes(neighbor)) continue;
      const occupiedBy = occupancy.get(neighbor) || [];
      const route = [...path, neighbor];
      if (occupiedBy.length > 0) {
        if (transit && occupiedBy.length === 1 && (canAbilityTransit(transit,pokemon,occupiedBy[0]) && !sphereAbilityBlocks.has(pokemon*12+occupiedBy[0])
          || (balloonTargets.has(pokemon) || basePassage.has(occupiedBy[0]) || spherePairs.has(pokemon*12+occupiedBy[0])) && !movementNonAbilityTransitBlockers(transit,pokemon,occupiedBy[0]).length)) collect(pokemon,route,maximumSteps);
        continue;
      }
      const move = { selective_side: side, value: { route, type: "mp_move" } };
      if ((!transit || !unverifiedTransitRouteBlockers(transit,pokemon,route).length) && planMovementSurround(match, move).ok) results.push(move);
      collect(pokemon, route, maximumSteps);
    }
  };
  for (let pokemon = firstIndex; pokemon < firstIndex + 6; pokemon += 1) {
    if (allowedPokemon >= 0 && pokemon !== allowedPokemon) continue;
    if (Number(match.waits?.get(pokemon) || 0) > 0 || USE_BLOCKING_CONDITIONS.has(match.conditions?.get(pokemon))) continue;
    if (transit && movementMpBlockers(transit,pokemon).length) continue;
    const source = match.positions.get(pokemon);
    if (hasBenchSpotEntry(pokemonDefinition(match,pokemon)?.pokepower,source)) continue;
    const authoredMp = Number(pokemonDefinition(match, pokemon)?.mp || 0);
    // The attachment outlives the initial selected-figure transaction and the
    // activation turn. Do not derive its MP from pendingPlate after that turn.
    const balloon = hasAirBalloonAttachment(match.plateState, pokemon);
    const baseMp = authoredMp + entryBlockadeMpBonus(transit,pokemon);
    const effectiveMp = balloon ? 2 : Number.isFinite(options.mpOverride) ? Number(options.mpOverride)
      : sphereMovementMp(match.record,match.positions,match.plateState,pokemon,baseMp,FIELD_EDGES);
    const firstTurnPenalty = !balloon && !options.ignoreFirstTurnPenalty
      && side === match.record.first_player && match.turns[side] === 0 ? 1 : 0;
    const maximumSteps = Math.max(0, effectiveMp - firstTurnPenalty);
    if (source === undefined || maximumSteps === 0) continue;
    collect(pokemon, [source], maximumSteps);
  }
  return results;
}

function chooseLocalTrainingMove(match) {
  if (match.pendingTouch) return clone(match.pendingTouch.choices[0]);
  if (match.pendingBattles.length > 0) return clone(match.pendingBattles[0]);
  const pathOrder = new Map([27, 20, 15, 11, 6, 5, 4, 3].map((point, index) => [point, index + 1]));
  const routes = [...legalRoutes(match, "black"),...legalBenchEntryMoves(match,"black")];
  routes.sort((left, right) => {
    const score = (move) => {
      const route = moveType(move)==="spot_move" ? [move.value.from,move.value.to] : movementRoute(move);
      const pokemon = pokemonAtPoint(match, route[0]);
      const destination = route.at(-1);
      const progress = pathOrder.get(destination) ?? -100;
      return progress * 10000 - pokemon * 100 + route.length;
    };
    return score(right) - score(left);
  });
  return routes[0] ?? null;
}

function chooseOpponentMove(match) {
  if (match.pendingTouch) return clone(match.pendingTouch.choices[0]);
  if (match.pendingBattles.length > 0) return clone(match.pendingBattles[0]);
  const pending = match.pendingPlate;
  const options = pending?.side === "white" ? {
    allowedPokemon: pending.pokemon,
    ignoreFirstTurnPenalty: pending.plateId === 5426,
    mpOverride: pending.plateId === 5426 ? 2 : Number.NaN,
  } : {};
  const routes = [...legalRoutes(match, "white", options),...legalBenchEntryMoves(match,"white",options)];
  const blackPoints = [...match.positions.entries()].filter(([pokemon]) => pokemon < 6).map(([, point]) => point);
  const fieldBlackPoints = blackPoints.filter((point) => point < 28);
  const distanceToBlack = (destination) => {
    if (fieldBlackPoints.length === 0) return 100;
    const visited = new Set([destination]);
    let frontier = [destination];
    for (let distance = 0; frontier.length > 0 && distance < 28; distance += 1) {
      if (frontier.some((point) => fieldBlackPoints.includes(point))) return distance;
      const next = [];
      for (const point of frontier) {
        for (const neighbor of BOARD_GRAPH.get(point) || []) {
          if (neighbor >= 28 || visited.has(neighbor)) continue;
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
      frontier = next;
    }
    return 100;
  };
  routes.sort((left, right) => {
    const score = (move) => {
      const route = moveType(move)==="spot_move" ? [move.value.from,move.value.to] : movementRoute(move);
      const pokemon = pokemonAtPoint(match, route[0]);
      const destination = route.at(-1);
      const occupied = pokemonAtPoint(match, destination);
      const collisionPenalty = occupied >= 0 && sideForPokemon(occupied) === "black" ? 500 : 0;
      // The training opponent follows the same legal route graph but closes
      // distance instead of orbiting away from the player. That makes normal
      // adjacent battle choices occur through the recovered two-command turn.
      return -distanceToBlack(destination) * 10000 - collisionPenalty - Math.abs(pokemon - 6) * 10 + route.length;
    };
    return score(right) - score(left);
  });
  return routes[0] ?? null;
}

function figureDeckItem(id, deckNo, deckIndex, figure) {
  const userItemId = id * 100 + deckIndex + 1;
  const figureMaster = {
    item_master_id: figure.itemMasterId,
    figure_number: figure.figureNumber,
    model: figure.modelId,
    mp: figure.mp,
    playable: true,
  };
  // Item 1296's rarity is not present in the preserved runtime cache. Omitting
  // it lets the client retain FigureThumbnail's serialized default instead of
  // manufacturing master data that was never observed.
  if (figure.rarity != null) figureMaster.rarity = figure.rarity;
  return {
    user_id: id,
    deck_no: deckNo,
    deck_index: deckIndex,
    figure_user_item_id0: userItemId,
    figure_user_item_id1: -1,
    figure_user_item_id2: -1,
    figure_user_item_id3: -1,
    figure_user_items: [{
      user_item_id: userItemId,
      item_type: 1,
      item_master_id: figure.itemMasterId,
      item_master: {
        item_master_id: figure.itemMasterId,
        item_type: 1,
        figure_master: figureMaster,
      },
      user_figure: {
        user_id: id,
        user_item_id: userItemId,
        level: 5,
        experience: 80000,
      },
    }, {}, {}, {}],
  };
}

function plateDeckItem(id, index, master) {
  return {
    user_item_id: id * 100 + 50 + index,
    item_type: 2,
    item_master_id: Number(master.item_master_id),
    item_master: {
      item_master_id: Number(master.item_master_id),
      item_type: 2,
      plate_master: clone(master),
    },
  };
}

function playerSummary(id, name, bw, plateMasters, equippedPlateIds, figures, deckNo = 1) {
  const equipped = equippedPlateIds.map((plateId) => plateMasters.find(
    (master) => Number(master.item_master_id) === Number(plateId),
  )).filter(Boolean);
  return {
    online_match_id: 0,
    user_id: id,
    deck_no: deckNo,
    bw,
    prev_rating: 1000,
    current_arena: { arena_league_master_id: 101 },
    deck: {
      user_id: id,
      deck_no: deckNo,
      plate_user_items: equipped.map((master, index) => plateDeckItem(id, index, master)),
      user_deck_figures: figures.map((figure, index) => figureDeckItem(id, deckNo, index, figure)),
    },
    user: {
      user_id: id,
      name,
      public: { user_id: id, name, rate: 1000 },
    },
  };
}

export class CustomMatchService {
  constructor({
    bindHost,
    publicHost,
    port,
    moveDelayMs = 250,
    opponentTurnDelayMs = 2500,
    opponentPlateContinuationDelayMs = moveDelayMs,
    opponentPlateMode = "off",
    battleEvidenceMode = "off",
    plateMasters = [],
    spinUnitSource = randomWheelIndex,
    conditionChoiceSource = randomWheelIndex,
    knockoutChoiceSource = randomWheelIndex,
    initialTimeMs = 300000,
    timerIntervalMs = 250,
    clockSource = Date.now,
    connectionServerFactory = createTcpServer,
    authenticateSession = null,
  }) {
    if (!["off", "native_white_long_throw_once", "native_white_air_balloon_once", "native_white_full_heal_once"].includes(opponentPlateMode)) {
      throw new Error(`invalid_opponent_plate_mode_${opponentPlateMode}`);
    }
    if (!["off", "native_white_blue_1620_paralysis_once", "native_black_purple_1085_sleep_white_once", "native_bridge_1227_speedup_once"].includes(battleEvidenceMode)) {
      throw new Error(`invalid_battle_evidence_mode_${battleEvidenceMode}`);
    }
    this.bindHost = bindHost;
    this.publicHost = publicHost;
    this.port = port;
    this.moveDelayMs = moveDelayMs;
    this.opponentTurnDelayMs = opponentTurnDelayMs;
    this.opponentPlateContinuationDelayMs = opponentPlateContinuationDelayMs;
    this.opponentPlateMode = opponentPlateMode;
    this.battleEvidenceMode = battleEvidenceMode;
    this.plateMasters = plateMasters;
    this.spinUnitSource = spinUnitSource;
    this.conditionChoiceSource = conditionChoiceSource;
    if (typeof knockoutChoiceSource !== "function") throw new Error("invalid_knockout_choice_source");
    this.knockoutChoiceSource = knockoutChoiceSource;
    this.initialTimeMs = Math.max(1, Number(initialTimeMs) || 300000);
    this.timerIntervalMs = Math.max(50, Number(timerIntervalMs) || 250);
    this.clockSource = clockSource;
    if (authenticateSession != null && typeof authenticateSession !== "function") throw new Error("invalid_session_authenticator");
    this.authenticateSession = authenticateSession;
    this.timerHandle = null;
    this.matches = new Map();
    this.tickets = new Map();
    this.sockets = new Set();
    this.nextMatchId = 1000000;
    this.server = connectionServerFactory((socket) => this.attach(socket));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.bindHost, () => {
        this.server.removeListener("error", reject);
        this.port = this.server.address().port;
        if (!this.timerHandle) {
          this.timerHandle = setInterval(() => this.tickMatchTimers(), this.timerIntervalMs);
          this.timerHandle.unref?.();
        }
        resolve();
      });
    });
  }

  close() {
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }

  enter(session, user = null, selectedDeck = null) {
    let match = this.matches.get(session);
    if (!match || match.phase === "reset") {
      match = this.createMatch(session, user, selectedDeck);
      this.matches.set(session, match);
    }
    return this.status(match, 1);
  }

  poll(session, user = null) {
    const match = this.matches.get(session) ?? this.createAndStore(session, user);
    match.pollCount += 1;
    if (match.phase === "waiting") match.phase = "found";
    return this.status(match, match.phase === "waiting" ? 1 : match.phase === "finished" ? 11 : match.phase === "started" ? 10 : 3);
  }

  cancel(session) {
    const match = this.matches.get(session);
    if (match && !["started", "finished"].includes(match.phase)) {
      match.phase = "reset";
      return true;
    }
    return !match;
  }

  reset(session) {
    const match = this.matches.get(session);
    if (match) match.phase = "reset";
    this.matches.delete(session);
    return true;
  }

  issueTicket(session) {
    const match = this.matches.get(session);
    if (!match || !["found", "started"].includes(match.phase)) throw new Error("battle_match_unavailable");
    if (!this.sessionIsAuthorized(session, match.localUser.user_id)) throw new Error("matching_authentication_required");
    const ticket = randomUUID();
    this.tickets.set(ticket, { session, expiresAt: Date.now() + 60_000 });
    return ticket;
  }

  result(session, matchId) {
    const match = this.matches.get(session);
    if (!match || Number(match.id) !== Number(matchId) || match.phase !== "finished") throw new Error("match_result_unavailable");
    const won = match.winner === "black";
    return {
      online_match_id: match.id,
      prev_point: 0,
      after_point: won ? 1 : 0,
      prev_rating: 1000,
      after_rating: won ? 1010 : 990,
      prev_star: 0,
      after_star: won ? 1 : 0,
      user_arena_rewards: [],
      user_arena_ranking_changes: [],
      user_rental_decks: [],
      is_shield: false,
    };
  }

  userInfo(session, baseUser) {
    const user = clone(baseUser);
    const match = this.matches.get(session);
    if (match && match.phase !== "reset") user.private = { matching_status: this.status(match, match.phase === "finished" ? 11 : match.phase === "started" ? 10 : match.phase === "found" ? 3 : 1) };
    return user;
  }

  createAndStore(session, user = null) {
    const match = this.createMatch(session, user);
    this.matches.set(session, match);
    return match;
  }

  createMatch(session, user = null, selectedDeck = null) {
    const id = this.nextMatchId++;
    const localUser = {
      user_id: Number(user?.user_id ?? LOCAL_USER_ID),
      display_name: String(user?.display_name ?? user?.name ?? "Local Player"),
    };
    const record = applyBattleEvidenceRecord(applySelectedDeck(makeRecord(id), selectedDeck), this.battleEvidenceMode);
    record.players[0].id = String(localUser.user_id);
    return {
      id,
      session,
      localUser,
      selectedDeckNo: Number(selectedDeck?.deck_no ?? 1),
      phase: "waiting",
      pollCount: 0,
      record,
      positions: new Map(Array.from({ length: 12 }, (_, index) => [index, 28 + index])),
      turn: "black",
      turns: { black: 0, white: 0 },
      completedTurnLedger: null,
      pendingBattles: [],
      battleResolutionPending: false,
      pendingPlate: null,
      pendingRespin: null,
      pendingGrudge: null,
      pendingTouch: null,
      pendingKnockouts: null,
      pendingSecondarySpins: null,
      opponentPlateUsed: false,
      battleEvidenceUsed: false,
      damageBonuses: new Map(),
      conditions: new Map(Array.from({ length: 12 }, (_, index) => [index, "normal"])),
      triangles: new Map(Array.from({ length: 12 }, (_, index) => [index, "empty"])),
      battledAfterField: new Map(Array.from({ length: 12 }, (_, index) => [index, false])),
      waits: new Map(Array.from({ length: 12 }, (_, index) => [index, 0])),
      disabledSkills: new Map(),
      blackTimeMs: this.initialTimeMs,
      whiteTimeMs: this.initialTimeMs,
      activeClockSide: "",
      clockStartedAtMs: 0,
      lastTimeBroadcastSecond: -1,
      zGauge: { black: 0, white: 0 },
      winner: "",
      reason: "",
      socket: null,
      serverSendIndex: -1,
      clientSendIndex: -1,
    };
  }

  status(match, statusCode) {
    const localUserId = Number(match.localUser?.user_id ?? LOCAL_USER_ID);
    const localDisplayName = String(match.localUser?.display_name ?? "Local Player");
    const onlineMatch = statusCode >= 3 ? {
      online_match_id: match.id,
      match_type: 1,
      player1: playerSummary(localUserId, localDisplayName, 0, this.plateMasters, match.record.players[0].plates, recordDeck(match.record, 0), Number(match.selectedDeckNo ?? 1)),
      player2: playerSummary(OPPONENT_USER_ID, "Training Opponent", 1, this.plateMasters, match.record.players[1].plates, recordDeck(match.record, 1)),
      arena: { black_league_master_id: 101, white_league_master_id: 101 },
      game_server: {
        public_name: this.publicHost,
        port: this.port,
        protocol_version: "custom.2",
        ai_version: "evidence-base.1",
        plate_state_schema: 1,
        z_state_schema: 1,
      },
    } : null;
    return { room_id: match.id, status: statusCode, online_match: onlineMatch, tentative_user: null };
  }

  attach(socket) {
    const state = { buffer: "", match: null };
    this.sockets.add(socket);
    socket.setNoDelay?.(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      state.buffer += chunk;
      if (Buffer.byteLength(state.buffer, "utf8") > MAX_LINE_BYTES) {
        socket.destroy(new Error("battle_receive_buffer_overflow"));
        return;
      }
      while (true) {
        const newline = state.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = state.buffer.slice(0, newline).replace(/\r$/, "");
        state.buffer = state.buffer.slice(newline + 1);
        if (line) this.handleLine(socket, state, line);
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", (error) => {
      const match = state.match;
      console.error(`MATCH_SOCKET_ERROR ${JSON.stringify({
        schema: "kiwi-duel-match-socket-error-1",
        error: String(error?.message || error || "unknown"),
        match_id: Number(match?.id ?? 0),
        turn: String(match?.turn || ""),
        move_count: Number(match?.record?.all_moves?.length || 0),
        positions: match ? Object.fromEntries(match.positions.entries()) : {},
        conditions: match ? conditionSnapshot(match) : {},
        waits: match ? waitSnapshot(match) : {},
      })}`);
      this.sockets.delete(socket);
    });
  }

  handleLine(socket, state, line) {
    if (state.terminated || socket.destroyed || socket.writableEnded) return;
    if (state.match && (state.match.socket !== socket || !this.sessionIsAuthorized(state.match.session, state.match.localUser.user_id))) {
      state.terminated = true;
      socket.end("session_revoked\n");
      return;
    }
    let { command, payload } = splitCommand(line);
    if (command === "sequence") {
      const match = payload.match(/^(-?\d+)\s+(-?\d+)\s+([\s\S]+)$/);
      if (!match) return socket.destroy(new Error("invalid_sequence"));
      if (state.match) state.match.clientSendIndex = Math.max(state.match.clientSendIndex, Number(match[1]));
      ({ command, payload } = splitCommand(match[3]));
    }
    console.log(`${new Date().toISOString()} TCP ${command}`);
    if (command === "@login") {
      if (state.match) { state.terminated = true; socket.end("@login rejected\n"); return; }
      const parts = payload.split(/\s+/);
      const ticket = parts[1] ?? "";
      const ticketState = this.tickets.get(ticket);
      this.tickets.delete(ticket);
      if (!ticketState || ticketState.expiresAt < Date.now()) {
        state.terminated = true;
        socket.end("@login rejected\n");
        return;
      }
      const match = this.matches.get(ticketState.session);
      if (!match || !["found", "started"].includes(match.phase)
          || !this.sessionIsAuthorized(ticketState.session, match.localUser.user_id)
          || (this.authenticateSession != null && parts[0] !== String(match.localUser.user_id))) {
        state.terminated = true;
        socket.end("@login rejected\n");
        return;
      }
      state.match = match;
      match.socket = socket;
      match.phase = "started";
      socket.write("@login ok\n");
      return;
    }
    const match = state.match;
    if (!match) return socket.destroy(new Error("battle_login_required"));
    if (command === "playgame") {
      socket.write(`playgame ${JSON.stringify(makePlayGame(match))}\n`);
      return;
    }
    if (command === "ping" || command === "time") {
      if (command === "time") {
        this.syncMatchClock(match);
        const reported = Number(payload);
        // A client may report a lower local stopwatch value for liveness, but
        // it can never extend the authoritative server clock.
        if (Number.isFinite(reported) && reported >= 0) {
          match.blackTimeMs = Math.min(match.blackTimeMs, Math.floor(reported));
        }
        if (match.blackTimeMs <= 0) this.finish(match, "white", "timeout");
      }
      return;
    }
    if (command === "timer_start") {
      const side = String(payload || "").trim().toLowerCase();
      if (side === "black" && this.selectionSide(match) === "black") this.startMatchClock(match, side);
      return;
    }
    if (command === "go") {
      const move = match.turn === "black" ? chooseLocalTrainingMove(match) : null;
      this.sendSequenced(match, `go ${JSON.stringify(move ? { Move: move } : { ErrorCode: 1, ErrorMessage: "No legal move" })}`);
      return;
    }
    if (command === "lose") {
      this.finish(match, "white", payload.trim() || "resign");
      return;
    }
    if (command !== "do_move") return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return socket.destroy(new Error("invalid_move_json")); }
    const move = normalizeMove(parsed);
    if (!move || move.selective_side !== "black") return socket.destroy(new Error("invalid_player_move"));
    if (this.selectionSide(match) !== "black") {
      // Touch input and the authoritative opponent run on different clocks.
      // A command already queued by Android can arrive after the server has
      // advanced the side. Reject that stale command without destroying the
      // authenticated match socket or losing the rest of the match.
      console.error(`MATCH_MOVE_REJECTED ${JSON.stringify({
        schema: "kiwi-duel-match-move-rejected-1",
        error: "stale_player_turn",
        match_id: Number(match.id),
        turn: String(match.turn),
        move_count: Number(match.record.all_moves.length),
      })}`);
      return;
    }
    this.acceptPlayerMove(match, move);
  }

  rejectPlayerMove(match, error) {
    return match.socket?.destroy(new Error(error));
  }

  playerMoveAccepted(_match, _move, _side) {}

  preflightTurnRecord(match, additionalMove = null) {
    const result = checkedTurnRecord(match, additionalMove);
    if (!result.ok) return completionFailure(match, result.reason), null;
    try {
      const declaration = moveType(additionalMove) === "declare_battle" ? additionalMove.value : null;
      const battle = declaration ? [declaration.from_pokemon, declaration.to_pokemon]
        : ["pending", "applying"].includes(match.activeBattleResolution?.phase)
          ? [match.activeBattleResolution.attacker, match.activeBattleResolution.defender] : null;
      validateTurnCleanup(match, match.turn, additionalMove, battle);
    } catch (error) { return completionFailure(match, String(error.message)), null; }
    return result;
  }

  planCompletedTurn(match, side, kind, actionRecordIndex, additionalMove = null) {
    const result = plannedTurnCompletion(match, side, kind, actionRecordIndex, additionalMove);
    return result.ok ? result : (completionFailure(match, result.reason), null);
  }

  completeTurn(match, side, plan) {
    if (match.phase !== "started" || !plan?.ok) return false;
    const checked = checkedTurnRecord(match);
    if (!checked.ok) return completionFailure(match, checked.reason);
    const committed = commitCompletion(checked.state, plan.cause, match.record);
    if (!committed.ok) return completionFailure(match, committed.reason);
    if (!committed.changed) return false; // Exact callback retry never repeats cleanup/gauges.
    if (match.turn !== side || plan.cause.ended_side !== side) return completionFailure(match, "completion_turn_changed");
    // Prepare cleanup on owned rule-state copies. An unexpected invalid plate/Z
    // state must not commit the ordinal or partially decrement Waits.
    let projected;
    try {
      projected = turnRuleProjection(match);
      completeTurnCleanup(projected, side);
    }
    catch (error) { return completionFailure(match, String(error.message)); }
    for (const key of ["zState", "zFigures", "plateState", "waits", "turns", "damageBonuses", "disabledSkills", "turn",
      "pendingBattles", "battleResolutionPending", "pendingPlate", "pendingRespin", "pendingGrudge", "pendingTouch", "pendingKnockouts", "pendingSecondarySpins", "pendingJump", "pendingExtraBattle", "extraBattle"]) match[key] = projected[key];
    match.completedTurnLedger = committed.state;
    return true;
  }

  completedTurnCheckpoint(match) {
    const checked = checkedTurnRecord(match);
    return checked.ok ? snapshotLedger(checked.state, match.record) : checked;
  }

  appendMove(match, move) {
    const checked = this.preflightTurnRecord(match, move);
    if (!checked) return false;
    ensureZState(match);
    const state = ensurePlateState(match);
    if (moveType(move) === "declare_plate") applyPlateDeclaration(state, move, match.record.all_moves.length);
    match.record.all_moves.push(clone(move));
    match.completedTurnLedger = checked.state;
    this.queuePlateState(match);
    return true;
  }

  queuePlateState(match) {
    if (match.plateSnapshotQueued) return;
    match.plateSnapshotQueued = true;
    // A single snapshot follows the complete synchronous authoritative batch:
    // primary move, derived effects, turn completion and Z gauge additions.
    queueMicrotask(() => {
      match.plateSnapshotQueued = false;
      if (!["started", "finished"].includes(match.phase)) return;
      this.sendSequenced(match, `plate_state ${JSON.stringify(plateStateSnapshot(match))}`);
      this.sendSequenced(match, `z_state ${JSON.stringify(zStateSnapshot(match))}`);
    });
  }

  selectionSide(match) { return (match.pendingGrudge ? (match.pendingGrudge.declared ? "both" : match.pendingGrudge.side) : null) ?? match.pendingRespin?.side ?? match.pendingJump?.side ?? match.pendingExtraBattle?.side ?? match.turn; }

  acceptPlayerMove(match, move, side = "black") {
    const type = moveType(move);
    const enemy = otherSide(side);
    if (!["black", "white"].includes(side) || move?.selective_side !== side) {
      return this.rejectPlayerMove(match, "invalid_player_side");
    }
    if (!["mp_move", "spot_move", "declare_battle", "declare_plate", "declare_spin", "declare_respin", "null_move", "declare_turn_end", "resign", "z_skill", "touch"].includes(type)) {
      return this.rejectPlayerMove(match, "unsupported_player_move");
    }
    if (match.phase !== "started" || this.selectionSide(match) !== side) return this.rejectPlayerMove(match, "stale_player_turn");
    if (!match.pendingGrudge && !match.pendingRespin && !match.pendingJump && !match.pendingExtraBattle && !match.battleResolutionPending) {
      if (match.pendingTouch && type!=="resign" && (match.pendingTouch.binding!==touchBinding(match,match.pendingTouch)
          || !["touch","declare_battle","null_move"].includes(type))) return this.rejectPlayerMove(match,"touch_continuation_required");
      if (match.pendingBattles.length && !["declare_battle","null_move","resign",...(match.pendingTouch?["touch"]:[])].includes(type)) return this.rejectPlayerMove(match,"battle_continuation_required");
      if (type === "null_move" && match.pendingBattles.length && pendingMpBattleMandatory(match,side)) return this.rejectPlayerMove(match,"battle_required_after_mp");
    }
    const admittedRecord = this.preflightTurnRecord(match, move);
    if (!admittedRecord) return this.rejectPlayerMove(match, "completion_record_invalid");
    if (type !== "resign" && admittedRecord.state.completed_turns >= MAX_COMPLETIONS) {
      return this.rejectPlayerMove(match, "completion_capacity_reached");
    }
    const reservedMoves = match.pendingRespin ? (type === "declare_respin" ? 40 : 39)
      : type === "declare_battle" ? 52 : type === "mp_move" ? 60 : 64;
    if (type !== "resign" && !completionCapacityAvailable(match, move, reservedMoves)) return this.rejectPlayerMove(match, "completion_capacity_reached");
    if (match.pendingGrudge && type!=="resign") return this.acceptPendingGrudge(match,move,side);
    if (type==="declare_spin") return this.rejectPlayerMove(match,"grudge_selection_not_pending");
    if (match.pendingJump || match.pendingExtraBattle) {
      if (type === "resign") {
        if (!this.appendMove(match, move)) return;
        this.playerMoveAccepted(match, move, side);
        return this.finish(match, enemy, "resign");
      }
      return match.pendingJump ? this.acceptPendingJump(match, move, side) : this.acceptPendingExtraBattle(match, move, side);
    }
    const zState = ensureZState(match);
    if (type === "z_skill") {
      let selected;
      try {
        selected = selectZTransaction(zState, { action: move, legalActions: zChoices(match).choices,
          recordIndex: match.record.all_moves.length });
      } catch { return this.rejectPlayerMove(match, "illegal_player_z_skill"); }
      if (!this.pauseMatchClock(match)) return;
      if (!this.appendMove(match, move)) return;
      match.zState = selected;
      this.playerMoveAccepted(match, move, side);
      logMatchEvent(match, "player_z_skill", { ...selected.active });
      return;
    }
    if (zState.active && type !== "resign"
        && filterZPlayerContinuations(zState, [move], match.positions).length === 0) {
      return this.rejectPlayerMove(match, "z_continuation_required");
    }
    // The first respin choice is committed before its delayed spin executes.
    // Training uses this entry directly (human transport also guards it): a
    // second click cannot append another declaration or change it to a decline.
    if (match.pendingRespin?.declared) return this.rejectPlayerMove(match, "respin_already_declared");
    if (match.pendingRespin?.side === side) {
      const target = Number(match.pendingRespin.pokemon);
      const selected = Array.isArray(move.value?.pokemons) ? move.value.pokemons.map(Number) : [];
      if (type === "declare_respin" && selected.length === 1 && selected[0] === target) {
        if (!this.pauseMatchClock(match)) return;
        if (!this.appendMove(match, move)) return;
        this.playerMoveAccepted(match, move, side);
        match.pendingRespin.declared = true;
        logMatchEvent(match, "player_declare_respin", { pokemon: target, plate_id: 5015 });
        this.schedulePendingRespin(match);
        return;
      }
      if (type === "null_move") {
        if (!this.pauseMatchClock(match)) return;
        if (!this.appendMove(match, move)) return;
        this.playerMoveAccepted(match, move, side);
        logMatchEvent(match, "player_decline_respin", { pokemon: target, plate_id: 5015 });
        this.finishPendingBattleWithoutRespin(match);
        return;
      }
      return this.rejectPlayerMove(match, "illegal_player_respin_choice");
    }
    if (type === "declare_respin") {
      return this.rejectPlayerMove(match, "illegal_player_respin");
    }
    if (match.battleResolutionPending) return this.rejectPlayerMove(match, "battle_resolution_pending");
    if (type === "touch") return this.acceptTouchRecovery(match,move,side);

    if (type === "declare_plate" && match.pendingPlate) {
      return this.rejectPlayerMove(match, "plate_continuation_required");
    }
    if (type === "spot_move" && !validateBenchEntryMove(match,side,move)) return this.rejectPlayerMove(match,"illegal_player_spot_move");
    if (type === "mp_move" && !validateMovement(match, side, move)) {
      return this.rejectPlayerMove(match, "illegal_player_movement");
    }
    if (type === "declare_battle") {
      const capability = zBattleCapability(match, move.value.from_pokemon, move.value.to_pokemon);
      if (!capability.ok) return this.rejectPlayerMove(match, capability.code);
      if (!validateBattleDeclaration(match, side, move)) return this.rejectPlayerMove(match, "illegal_player_battle");
    }
    if (type === "null_move" && match.pendingBattles.length === 0 && !match.pendingTouch) {
      return this.rejectPlayerMove(match, "illegal_player_null_move");
    }
    if (type === "declare_plate" && !validatePlateMove(match, side, move)) {
      return this.rejectPlayerMove(match, "illegal_player_plate");
    }
    const surround = ["mp_move","spot_move"].includes(type) || type === "declare_plate" && ["spot_move", "swap_move"].includes(nestedPlateType(move))
      ? planMovementSurround(match, move) : null;
    if (surround && !surround.ok) return this.rejectPlayerMove(match, surround.reason);
    if (type === "declare_turn_end" && match.pendingPlate?.side !== side) {
      return this.rejectPlayerMove(match, "illegal_player_turn_end");
    }
    const recovery=type==='declare_battle'?planDeclarationConditionRecovery(match,move):null;
    if(recovery&&!recovery.ok)return this.rejectPlayerMove(match,recovery.reason);
    const kind = recovery?.cancelled?'declaration_surround':completionKind(move);
    const completionPlan = kind ? this.planCompletedTurn(match, side, kind, match.record.all_moves.length, move) : null;
    if (kind && !completionPlan) return this.rejectPlayerMove(match, "completion_plan_invalid");
    if (!this.pauseMatchClock(match)) return;
    const route = type === "spot_move" ? [move.value.from,move.value.to] : movementRoute(move);
    const destination = route.length ? route.at(-1) : -1;
    const movingPokemon = route.length ? pokemonForSideAtPoint(match, route[0], side) : -1;
    const occupiedPokemon = destination >= 0 ? pokemonForSideAtPoint(match, destination, enemy) : -1;
    const opponentOccupied = occupiedPokemon >= 0 && sideForPokemon(occupiedPokemon) === enemy;
    if (!this.appendMove(match, move)) return;
    const acceptedMoveIndex=match.record.all_moves.length-1;
    applyPositionMove(match, move);
    for(const [pokemon,condition] of recovery?.changes??[])match.conditions.set(pokemon,condition);
    this.playerMoveAccepted(match, move, side);
    if(recovery)this.applyConditionRecoverySurround(match,recovery);
    if (surround) this.applyMovementSurround(match, surround.grudgeEntry>=0?{...surround,targets:[]}:surround);
    logMatchEvent(match, "player_move", {
      move_type: type,
      route,
      plate_id: Number(move.value?.plate_id ?? -1),
    });
    if (type === "resign") return this.finish(match, enemy, "resign");
    if(recovery?.cancelled){
      if(!this.completeTurn(match,side,completionPlan))return false;
      this.applyZGaugeAwards(match,[turnStartGaugeAward(match.turn,match.positions,FIELD_POINT_Z)]);
      setTimeout(()=>this.playOpponentTurn(match),this.opponentTurnDelayMs);
      return true;
    }
    if (destination === (side === "black" ? 3 : 24) && match.positions.get(movingPokemon) === destination) return this.finish(match, side, "goal");
    if (surround?.grudgeEntry>=0) return this.stagePendingGrudge(match,side,surround.grudgeEntry,move,match.record.all_moves.length-1);
    if (type === "declare_battle") {
      match.pendingTouch=null;
      if (zState.active) match.zState = advanceZTransaction(zState, {
        kind: "declare_battle", pokemon: move.value.from_pokemon, defender: move.value.to_pokemon,
      });
      match.battleResolutionPending = true;
      const declaration = { index: acceptedMoveIndex, move: clone(move), started: false };
      match.activeBattleDeclaration = declaration;
      setTimeout(() => this.resolveBattle(match, move, declaration), this.moveDelayMs);
      return;
    }
    if (type === "declare_plate") {
      const plateId = Number(move.value.plate_id);
      const nested = move.value.value || {};
      const nestedType = String(nested.type || "");
      if (!SUPPORTED_SPHERE_IDS.includes(plateId) && ["select_pokemon", "select_pokemon_and_declare_aura", "put_circle"].includes(nestedType)) {
        const pokemon = nestedType === "put_circle" ? Number(nested.pokemons?.[0]) : Number(nested.pokemon);
        match.pendingPlate = { side, plateId, pokemon };
        if (plateId === 5022) match.damageBonuses.set(pokemon, 30);
        // Healing has not moved the selected figure. Keep the plate's ordinary
        // selected-figure continuation; only actual movement opens the narrower
        // battle-or-decline phase. validateBattleDeclaration still allows the
        // healed figure to attack an adjacent opponent directly.
        return;
      }
    }
    if (type === "mp_move") {
      match.pendingBattles = pendingBattlesAfterMovement(
        match,
        side,
        movingPokemon,
        destination,
        opponentOccupied ? occupiedPokemon : -1,
        true,
      );
      // Double Chance and X Attack remain active through the selected figure's
      // same-turn battle. Air Balloon likewise survives movement until the turn
      // boundary. completeTurn owns the authoritative plate cleanup.
      if (match.pendingPlate?.side !== side || match.pendingPlate?.pokemon !== movingPokemon) {
        match.pendingPlate = null;
      }
      const touchPending=this.stagePendingTouch(match,side,movingPokemon);
      if (match.pendingBattles.length > 0 || touchPending) {
        if (zState.active) match.zState = advanceZTransaction(zState, {
          kind: "move_into_battle_choice", pokemon: movingPokemon,
        });
        return;
      }
    }
    if (!moveEndsTurn(move, opponentOccupied)) return;
    if (!this.completeTurn(match, side, completionPlan)) return;
    this.applyZGaugeAwards(match, [turnStartGaugeAward(match.turn, match.positions, FIELD_POINT_Z)]);
    // The original presentation owns a 1.5-second side-change cut-in. Pace
    // the training opponent across that boundary rather than racing its move
    // into the client's movement/cut-in queue.
    setTimeout(() => this.playOpponentTurn(match), this.opponentTurnDelayMs);
  }

  stagePendingGrudge(match,side,pokemon,entryMove,entryIndex) {

    if (moveType(entryMove)==="mp_move" && (match.pendingPlate?.side!==side || match.pendingPlate?.pokemon!==pokemon)) match.pendingPlate=null;
    const pending={side,pokemon,entryMove:clone(entryMove),entryIndex,declared:false};pending.binding=grudgeBinding(match,pending);
    match.pendingGrudge=pending;match.pendingBattles=[];
    logMatchEvent(match,"grudge_entry",{pokemon,entry_index:entryIndex});
    this.scheduleOpponentGrudge(match,pending);
    return true;
  }

  stagePendingTouch(match,side,pokemon) {
    const mandatory=restrictPostMpBattles(match.record,match.positions,pokemon,BOARD_GRAPH,match.pendingBattles).mandatory;
    const choices=mandatory?[]:touchRecoveryChoices(side,match.positions,match.conditions,match.waits,BOARD_GRAPH,[pokemon]);
    match.pendingTouch=choices.length?{side,pokemon,choices}:null;
    if(match.pendingTouch) match.pendingTouch.binding=touchBinding(match,match.pendingTouch);
    return choices.length>0;
  }

  touchChoices(match,side) {
    if(match.pendingTouch) return match.pendingTouch.side===side && match.pendingTouch.binding===touchBinding(match,match.pendingTouch)
      ? touchRecoveryChoices(side,match.positions,match.conditions,match.waits,BOARD_GRAPH,[match.pendingTouch.pokemon]):[];
    if(match.pendingBattles.length || match.pendingPlate || match.pendingGrudge || match.pendingRespin
        || match.pendingJump || match.pendingExtraBattle || match.battleResolutionPending || match.turn!==side) return [];
    return touchRecoveryChoices(side,match.positions,match.conditions,match.waits,BOARD_GRAPH);
  }

  acceptTouchRecovery(match,move,side,broadcast=false) {
    if(!validTouchRecovery(move,this.touchChoices(match,side))) return this.rejectPlayerMove(match,"illegal_player_touch");
    const projected=turnRuleProjection(match);
    projected.conditions.set(move.value.to_pokemon,"normal");
    const surrounding=surroundingPlan(projected.record,projected.positions,projected.conditions,FIELD_EDGES);
    if(!surrounding.ok) return this.rejectPlayerMove(match,surrounding.reason);
    const steps=planKnockoutRelocations(projected,surrounding.targets.map(pokemon=>({pokemon,from:projected.positions.get(pokemon)})),{requireFaint:false});
    if(!steps) return this.rejectPlayerMove(match,"touch_invalid_center");
    const completion=this.planCompletedTurn(match,side,"touch",match.record.all_moves.length,move);
    if(!completion || !this.pauseMatchClock(match) || !this.appendMove(match,move)) return false;
    match.conditions.set(move.value.to_pokemon,"normal");
    this.playerMoveAccepted(match,move,side);
    if(broadcast) this.sendSequenced(match,`do_move ${JSON.stringify(move)}`);
    this.applyMovementSurround(match,{...surrounding,steps});
    for(const step of steps) if(step.excluded===undefined) this.applyZGaugeAwards(match,[{
      cause:"touch_surround_knockout",deltas:{black:0,white:0,[sideForPokemon(step.pokemon)]:10}}]);
    if(!this.completeTurn(match,side,completion)) return false;
    this.applyZGaugeAwards(match,[turnStartGaugeAward(match.turn,match.positions,FIELD_POINT_Z)]);
    setTimeout(()=>this.playOpponentTurn(match),this.opponentTurnDelayMs);
    return true;
  }

  applyConditionRecoverySurround(match,plan) {
    this.applyMovementSurround(match,plan);
    for(const step of plan.steps)if(step.excluded===undefined)this.applyZGaugeAwards(match,[{
      cause:'condition_recovery_surround_knockout',deltas:{black:0,white:0,[sideForPokemon(step.pokemon)]:10}}]);
  }

  scheduleOpponentGrudge(match,pending) {
    if (pending.side!=="white") return;
    setTimeout(()=>{
      if (match.phase!=="started" || match.pendingGrudge!==pending || pending.declared) return;
      const choices=grudgeStoneChoices(pending.side,match.positions);
      const selected=choices.find(a=>sideForPokemon(a.value.pokemons[0])!==pending.side)??choices[0];
      if (selected) this.acceptPlayerMove(match,selected,pending.side);
    },this.opponentTurnDelayMs);
  }

  acceptPendingGrudge(match,move,side) {
    const pending=match.pendingGrudge;
    if (!pending || pending.declared || pending.side!==side || pending.binding!==grudgeBinding(match,pending)
        || !validGrudgeSelection(move,side,match.positions)) return this.rejectPlayerMove(match,"invalid_grudge_selection");
    if (!this.pauseMatchClock(match) || !this.appendMove(match,move)) return false;
    pending.target=move.value.pokemons[0];pending.declared=true;pending.binding=grudgeBinding(match,pending);
    this.playerMoveAccepted(match,move,side);
    this.schedulePendingGrudge(match,pending);
    return true;
  }

  schedulePendingGrudge(match,pending) {
    setTimeout(()=>this.performPendingGrudge(match,pending),this.moveDelayMs);
  }

  performPendingGrudge(match,pending) {
    if (match.phase!=="started" || !pending || match.pendingGrudge!==pending || !pending.declared
        || pending.binding!==grudgeBinding(match,pending) || match.turn!==pending.side) return false;
    if (!this.preflightTurnRecord(match) || !completionCapacityAvailable(match,null,16)) return false;
    const target=pending.target;
    const skills=(pokemonDefinition(match,target)?.skills??[]).filter(skill=>Number(skill.range)>0);
    const range=skills.reduce((sum,skill)=>sum+Number(skill.range),0);
    if (!Number.isInteger(range)||range<=0||match.positions.get(target)<0||match.positions.get(target)>=28) return false;
    const unit=this.spinUnitSource(range,target);
    if (!Number.isInteger(unit)||unit<0||unit>=range) return completionFailure(match,"invalid_grudge_spin_rng");
    const displace=0;
    // Original Grudge probability spins use the printed wheel without Panic
    // displacement or the disabled/color/repeated-hit battle preparation.
    let cumulative=0;
    const skill=skills.find(segment=>(cumulative+=Number(segment.range))>unit);
    if (!skill) return false;
    const spin={selective_side:"both",value:{spins:[{pokemon:target,results:[{displace,num:unit,type:"probability"}]}],type:"spin"}};
    const projected=turnRuleProjection(match);
    if (Number(skill.color)===1) projected.triangles.set(target,"curse");
    const surrounding=surroundingPlan(projected.record,projected.positions,projected.conditions,FIELD_EDGES);
    if (!surrounding.ok) return false;
    const steps=planKnockoutRelocations(projected,surrounding.targets.map(pokemon=>({pokemon,from:projected.positions.get(pokemon)})),{requireFaint:false});
    if (!steps) return false;
    this.applyMovementSurround(projected,{...surrounding,steps});
    const battles=moveType(pending.entryMove)==="mp_move"
      ? pendingBattlesAfterMovement(projected,pending.side,pending.pokemon,projected.positions.get(pending.pokemon),-1,true):[];
    projected.pendingBattles=battles;
    const touchPending=moveType(pending.entryMove)==="mp_move" && this.stagePendingTouch(projected,pending.side,pending.pokemon);
    const continuation=battles.length>0 || touchPending;
    const completion=continuation?null:this.planCompletedTurn(match,pending.side,completionKind(pending.entryMove),pending.entryIndex,spin);
    if (!continuation&&!completion) return false;
    if (!this.appendMove(match,spin)) return false;
    for (const field of ["positions","conditions","triangles","waits","disabledSkills","battledAfterField"]) match[field]=projected[field];
    match.pendingGrudge=null;match.pendingBattles=battles;
    if(moveType(pending.entryMove)==="mp_move") this.stagePendingTouch(match,pending.side,pending.pokemon);
    this.sendSequenced(match,`do_move ${JSON.stringify(spin)}`);
    logMatchEvent(match,"grudge_probability",{pokemon:pending.pokemon,target,selected_color:Number(skill.color),pending_battles:battles.length});
    if (!continuation) {
      if (!this.completeTurn(match,pending.side,completion)) return false;
      this.applyZGaugeAwards(match,[turnStartGaugeAward(match.turn,match.positions,FIELD_POINT_Z)]);
      setTimeout(()=>this.playOpponentTurn(match),this.opponentTurnDelayMs);
    } else if (pending.side==="white") setTimeout(()=>this.playOpponentTurn(match),this.opponentTurnDelayMs);
    return true;
  }

  resolveBattle(match, declaration, binding = match.activeBattleDeclaration) {
    if (match.phase !== "started" || !match.socket) return;
    if (binding && (binding !== match.activeBattleDeclaration || binding.started
        || JSON.stringify(match.record.all_moves[binding.index]) !== JSON.stringify(binding.move)
        || JSON.stringify(declaration) !== JSON.stringify(binding.move))) return;
    const attacker = Number(declaration.value.from_pokemon ?? declaration.value.FromPokemon ?? -1);
    const defender = Number(declaration.value.to_pokemon ?? declaration.value.ToPokemon ?? -1);
    const attackingSide = sideForPokemon(attacker);
    if (match.turn !== (binding?.turnSide ?? attackingSide)) return;
    if (!this.preflightTurnRecord(match) || !completionCapacityAvailable(match, null, 44)) return;
    const disabledMoves = [];
    try {
      for (const pokemon of [attacker, defender]) {
        const zBlue = ensureZState(match).active?.pokemon === attacker && pokemon === defender
          && (pokemonDefinition(match, pokemon)?.skills || []).some(skill => Number(skill.id) === 1127 && Number(skill.range) > 0);
        const skillIds = conditionDisabledSkills(match, pokemon, this.conditionChoiceSource);
        if (zBlue && !skillIds.includes(1127)) skillIds.push(1127);
        if (skillIds.length) disabledMoves.push({display_info: "move", selective_side: zBlue ? "neither" : "both",
          value: { pokemon, skill_id: skillIds, type: "disable_skill" }});
      }
    } catch (error) { return completionFailure(match, error.message); }
    if (binding) binding.started = true;
    for (const disableMove of disabledMoves) {
      const {pokemon, skill_id:skillIds} = disableMove.value;
      if (!this.appendMove(match, disableMove)) return;
      if (!match.disabledSkills.has(pokemon)) match.disabledSkills.set(pokemon, new Set());
      for (const skillId of skillIds) match.disabledSkills.get(pokemon).add(skillId);
      this.sendSequenced(match, `do_move ${JSON.stringify(disableMove)}`);
    }
    if (disabledMoves.length > 0) {
      logMatchEvent(match, "battle_disable_skill", {
        disabled: disabledMoves.map((move) => ({
          pokemon: Number(move.value.pokemon),
          skill_id: move.value.skill_id.map(Number),
        })),
      });
      setTimeout(() => this.performBattleSpin(match, attacker, defender, attackingSide, binding), this.moveDelayMs);
      return;
    }
    this.performBattleSpin(match, attacker, defender, attackingSide, binding);
  }

  performBattleSpin(match, attacker, defender, attackingSide, binding = match.activeBattleDeclaration) {
    if (match.phase !== "started" || !match.socket) return;
    if (binding && binding !== match.activeBattleDeclaration) return;
    const turnSide=binding?.turnSide ?? attackingSide;
    if (match.turn !== turnSide || ["pending", "applying"].includes(match.activeBattleResolution?.phase)) return;
    if (!this.preflightTurnRecord(match) || !completionCapacityAvailable(match, null, 42)) return;
    const attackerRange = wheelRange(match, attacker);
    const defenderRange = wheelRange(match, defender);
    if (attackerRange <= 0 || defenderRange <= 0) {
      this.finish(match, otherSide(sideForPokemon(attacker)), "invalid_wheel");
      return;
    }
    const observedUnits = this.chooseObservedBattleSpinUnits(match, attacker, defender);
    let attackerSpin, defenderSpin;
    try {
      attackerSpin = rollBattleWheel(match, attacker, this.spinUnitSource, observedUnits?.attackerUnit);
      defenderSpin = rollBattleWheel(match, defender, this.spinUnitSource, observedUnits?.defenderUnit);
    } catch (error) { return completionFailure(match, error.message); }
    const attackerUnit = attackerSpin.results[0].num;
    const defenderUnit = defenderSpin.results[0].num;
    const spin = {
      display_info: "move",
      selective_side: "both",
      value: {
        type: "spin",
        // MatchMain/Roulette receives the server list in fixed black-then-white
        // slot order even when white declared the battle.
        spins: [
          attackerSpin,
          defenderSpin,
        ].sort((left, right) => Number(left.pokemon) - Number(right.pokemon)),
      },
    };
    if (!this.appendMove(match, spin)) return;
    const spinRecordIndex = match.record.all_moves.length - 1;
    match.activeBattleResolution = { spinRecordIndex, attacker, defender, attackerUnit, defenderUnit,
      side: attackingSide, turnSide, phase: "pending" };
    this.sendSequenced(match, `do_move ${JSON.stringify(spin)}`);
    const plate = match.pendingPlate;
    const doubleChancePokemon = Number(plate?.pokemon ?? -1);
    if (plate?.side === attackingSide && Number(plate?.plateId) === 5015
        && [attacker, defender].includes(doubleChancePokemon)) {
      // Native query boundary: the first Spin is complete, but no field outcome
      // or turn transition is committed yet. The engine exposes exactly
      // DeclareRespin([selected Pokemon]) and null_move to the plate owner.
      match.pendingRespin = {
        side: attackingSide,
        pokemon: doubleChancePokemon,
        attacker,
        defender,
        attackingSide,
        turnSide,
        attackerUnit,
        defenderUnit,
        spinRecordIndex,
        evidenceMode: observedUnits?.mode ?? "off",
        declared: false,
      };
      logMatchEvent(match, "battle_respin_choice", {
        pokemon: doubleChancePokemon,
        plate_id: 5015,
        attacker_unit: attackerUnit,
        defender_unit: defenderUnit,
      });
      if (attackingSide === "white") {
        setTimeout(() => this.declareOpponentRespin(match), this.moveDelayMs);
      }
      return;
    }
    this.finishBattleSpin(match, {
      attacker,
      defender,
      attackingSide,
      turnSide,
      attackerUnit,
      defenderUnit,
      spinRecordIndex,
      evidenceMode: observedUnits?.mode ?? "off",
    });
  }

  declareOpponentRespin(match) {
    const pending = match.pendingRespin;
    if (match.phase !== "started" || !match.socket || pending?.side !== "white" || pending.declared) return;
    const declaration = {
      display_info: "move",
      selective_side: "white",
      value: { pokemons: [Number(pending.pokemon)], type: "declare_respin" },
    };
    if (!this.appendMove(match, declaration)) return;
    pending.declared = true;
    this.sendSequenced(match, `do_move ${JSON.stringify(declaration)}`);
    logMatchEvent(match, "opponent_declare_respin", { pokemon: Number(pending.pokemon), plate_id: 5015 });
    this.schedulePendingRespin(match);
  }

  schedulePendingRespin(match) {
    setTimeout(() => this.performPendingRespin(match), this.moveDelayMs);
  }

  performPendingRespin(match) {
    const pending = match.pendingRespin;
    if (match.phase !== "started" || !match.socket || !pending?.declared) return;
    if (!this.preflightTurnRecord(match) || !completionCapacityAvailable(match, null, 40)) return;
    const pokemon = Number(pending.pokemon);
    const totalRange = wheelRange(match, pokemon);
    if (totalRange <= 0) return this.finish(match, otherSide(pending.side), "invalid_wheel");
    let wheel;
    try { wheel = rollBattleWheel(match, pokemon, this.spinUnitSource); }
    catch (error) { return completionFailure(match, error.message); }
    const unit = wheel.results[0].num;
    const spin = {
      display_info: "move",
      selective_side: "both",
      value: {
        type: "spin",
        spins: [wheel],
      },
    };
    if (!this.appendMove(match, spin)) return;
    pending.spinRecordIndex = match.record.all_moves.length - 1;
    this.sendSequenced(match, `do_move ${JSON.stringify(spin)}`);
    if (pokemon === Number(pending.attacker)) pending.attackerUnit = unit;
    else pending.defenderUnit = unit;
    match.activeBattleResolution = { spinRecordIndex: pending.spinRecordIndex, attacker: pending.attacker,
      defender: pending.defender, attackerUnit: pending.attackerUnit, defenderUnit: pending.defenderUnit,
      side: pending.attackingSide, turnSide:pending.turnSide ?? pending.attackingSide, phase: "pending" };
    logMatchEvent(match, "battle_respin", {
      pokemon,
      unit,
      retained_pokemon: pokemon === Number(pending.attacker) ? Number(pending.defender) : Number(pending.attacker),
      retained_unit: pokemon === Number(pending.attacker) ? Number(pending.defenderUnit) : Number(pending.attackerUnit),
    });
    this.finishBattleSpin(match, pending);
  }

  finishPendingBattleWithoutRespin(match) {
    const pending = match.pendingRespin;
    if (match.phase !== "started" || !pending) return;
    this.finishBattleSpin(match, pending);
  }

  finishBattleSpin(match, state) {
    if (match.pendingKnockouts || !currentBattleResolution(match, state, "pending")) return false;
    if (!completionCapacityAvailable(match, null, 39)) return false;
    // Validate this possible completion before outcome/Wait/position mutations.
    // If native rules expose more KO commands, the candidate is not committed;
    // each final accepted continuation refreshes its prefix cut below.
    const completionPlan = this.planCompletedTurn(match, state.turnSide ?? state.attackingSide, "resolved_battle", state.spinRecordIndex);
    if (!completionPlan) return false;
    const attacker = Number(state.attacker);
    const defender = Number(state.defender);
    const attackingSide = String(state.attackingSide);
    const attackerUnit = Number(state.attackerUnit);
    const defenderUnit = Number(state.defenderUnit);
    let projected, outcome, targets = null, relocationSteps = null;
    try {
      projected = turnRuleProjection(match);
      outcome = this.applyBaseBattleOutcome(projected, attacker, defender, attackerUnit, defenderUnit, latestBattleSpinResults(match));
      if (outcome.pendingKnockoutTargets?.length) {
        targets = outcome.pendingKnockoutTargets.map(pokemon => ({ pokemon, from: projected.positions.get(pokemon) }));
        relocationSteps = planKnockoutRelocations(projected, targets);
        if (!relocationSteps?.length) return completionFailure(match, "completion_knockout_disposition_invalid");
      }
      validateTurnCleanup(projected, state.turnSide ?? attackingSide, null, [attacker, defender]);
      if (ensureZState(projected).active) finishZBattle(projected.zState, {
        attacker, defender, finalized: true, attackingSide,
        zBattleOutcome: outcome.winner === attacker ? "win" : outcome.winner < 0 ? "draw" : "lose",
        attackerColor: Number(outcome.attackerSkill.color), defenderColor: Number(outcome.defenderSkill.color),
        knockoutSide: outcome.knockout && !outcome.excluded && !outcome.knockoutAwardsApplied ? sideForPokemon(outcome.loser) : null,
      });
    } catch (error) { return completionFailure(match, String(error.message)); }
    match.activeBattleResolution.turnCompletionPlan = completionPlan;
    match.activeBattleResolution.phase = "applying";
    for (const key of ["positions", "conditions", "triangles", "waits", "disabledSkills", "battledAfterField"]) match[key] = projected[key];
    if (outcome.pendingJump) return this.stagePendingJump(match, state, outcome);
    if (outcome.secondarySpins?.length) {
      const pending = {state: clone(state), outcome, recordMoveCount: match.record.all_moves.length, planIndex:0};
      match.pendingSecondarySpins = pending;
      this.scheduleSecondarySpins(match, pending);
      return;
    }
    if (outcome.pendingKnockoutTargets?.length) {
      if (targets.length === 1) {
        // Native single-rehit resolves one faint inline. It does not add a
        // both-side input; only the multiple-faint branch waits for that choice.
        this.completeKnockoutBatch(match, state, outcome, relocationSteps);
        return;
      }
      this.stagePendingKnockouts(match, state, outcome, targets);
      return;
    }
    this.completeBattleResolution(match, state, outcome);
  }

  stagePendingJump(match, state, outcome) {
    const pending = {...outcome.pendingJump, state:clone(state), outcome,
      recordMoveCount:match.record.all_moves.length};
    match.pendingJump = pending;
    match.pendingRespin = null;
    match.pendingBattles = [];
    match.battleResolutionPending = true;
    // An empty landing set remains an explicit unresolved choice. Native
    // no-landing fallback has not been observed; do not invent a completion.
    logMatchEvent(match, "purple_jump_choice", {pokemon:pending.pokemon, targets:pending.targets,
      unresolved:pending.unresolved_reason ?? (pending.targets.length === 0 ? "no_landing_fallback_unobserved" : null)});
    this.scheduleOpponentJump(match, pending);
    return true;
  }

  scheduleOpponentJump(match, pending) {
    if (pending.side !== "white" || !pending.targets.length) return;
    setTimeout(() => {
      if (match.pendingJump !== pending) return;
      this.acceptPlayerMove(match, {selective_side:"white", value:{type:"spot_move", from:pending.from, to:pending.targets[0]}}, "white");
    }, this.opponentTurnDelayMs);
  }

  acceptPendingJump(match, move, side) {
    const pending = match.pendingJump, value = move.value;
    if (!pending || pending.side !== side || !currentBattleResolution(match, pending.state, "applying")
        || pending.recordMoveCount !== match.record.all_moves.length
        || moveType(move) !== "spot_move" || Object.keys(value).length !== 3
        || value.from !== pending.from || !pending.targets.includes(value.to)
        || match.positions.get(pending.pokemon) !== value.from || pokemonAtPoint(match, value.to) >= 0) {
      return this.rejectPlayerMove(match, "illegal_purple_jump_choice");
    }
    const landing = planJumpLanding(match, pending, move);
    if (!landing.ok) return this.rejectPlayerMove(match, landing.reason);
    const completionPlan = this.planCompletedTurn(match, pending.state.turnSide ?? pending.state.attackingSide, "resolved_battle", pending.state.spinRecordIndex, move);
    if (!completionPlan || !this.pauseMatchClock(match) || !this.appendMove(match, move)) return false;
    match.activeBattleResolution.turnCompletionPlan = completionPlan;
    applyPositionMove(match, move);
    this.playerMoveAccepted(match, move, side);
    if (landing.knockoutSteps.length) {
      pending.outcome.pendingKnockoutTargets=landing.knockoutSteps.map(step=>step.pokemon);
      pending.outcome.knockoutGaugeCause="base_battle_knockout";
      for (const pokemon of pending.outcome.pendingKnockoutTargets) match.conditions.set(pokemon,"faint");
      if (!this.completeKnockoutBatch(match,pending.state,pending.outcome,landing.knockoutSteps,{complete:false})) return false;
    }
    this.applyMovementSurround(match, landing.surround);
    applyPokepower1326(match, pending.state.attacker, pending.state.defender, pending.outcome.battledBefore);
    if(landing.recovery){
      for(const [pokemon,condition] of landing.recovery.changes)match.conditions.set(pokemon,condition);
      this.applyConditionRecoverySurround(match,landing.recovery);
    }
    if (match.positions.get(pending.pokemon) === (side === "black" ? 3 : 24)) return this.finish(match, side, "goal");
    match.pendingJump=null;
    if (pending.extraBattle && this.stagePendingExtraBattle(match,pending)) return true;
    return this.completeBattleResolution(match, pending.state, pending.outcome);
  }

  stagePendingExtraBattle(match, jump) {
    if (match.extraBattle?.used && match.extraBattle.source === jump.pokemon) return false;
    const source=match.positions.get(jump.pokemon);
    if (source < 0 || source >= 28 || match.waits.get(jump.pokemon)>0 || USE_BLOCKING_CONDITIONS.has(match.conditions.get(jump.pokemon))) return false;
    const unresolved=match.extraBattle?.used && match.extraBattle.source !== jump.pokemon;
    const choices=unresolved?[]:pendingBattlesAfterMovement(match,jump.side,jump.pokemon,source,-1);
    if (!unresolved && !choices.length) return false;
    match.extraBattle??={source:jump.pokemon,turnSide:jump.state.turnSide??jump.state.attackingSide,used:false};
    const pending={side:jump.side,pokemon:jump.pokemon,state:jump.state,outcome:jump.outcome,choices,
      recordMoveCount:match.record.all_moves.length,unresolved_reason:unresolved?"double_flight_other_figure_chain_scope_unverified":null};
    match.pendingExtraBattle=pending;match.pendingBattles=choices;match.battleResolutionPending=true;
    logMatchEvent(match,"double_flight_battle_choice",{pokemon:jump.pokemon,choices,unresolved:pending.unresolved_reason});
    this.scheduleOpponentExtraBattle(match,pending);
    return true;
  }

  scheduleOpponentExtraBattle(match,pending) {
    if (pending.side!=="white" || !pending.choices.length) return;
    setTimeout(()=>{if(match.pendingExtraBattle===pending)this.acceptPlayerMove(match,pending.choices[0],"white");},this.opponentTurnDelayMs);
  }

  acceptPendingExtraBattle(match,move,side) {
    const pending=match.pendingExtraBattle,type=moveType(move);
    if (!pending || pending.side!==side || pending.recordMoveCount!==match.record.all_moves.length
        || !currentBattleResolution(match,pending.state,"applying") || pending.unresolved_reason
        || !["declare_battle","null_move"].includes(type)
        || (type==="null_move"?Object.keys(move.value).length!==1:
          Object.keys(move.value).length!==3 || !pending.choices.some(choice=>JSON.stringify(choice.value)===JSON.stringify(move.value)
            || choice.value.type===type&&choice.value.from_pokemon===move.value.from_pokemon&&choice.value.to_pokemon===move.value.to_pokemon))) {
      return this.rejectPlayerMove(match,"illegal_double_flight_battle_choice");
    }
    if (type==="declare_battle") {
      const actor=pending.pokemon,target=move.value.to_pokemon;
      if (match.waits.get(actor)>0 || USE_BLOCKING_CONDITIONS.has(match.conditions.get(actor))
          || !pendingBattlesAfterMovement(match,side,actor,match.positions.get(actor),-1).some(m=>m.value.to_pokemon===target)) {
        return this.rejectPlayerMove(match,"illegal_double_flight_battle_choice");
      }
    }
    const recovery=type==='declare_battle'?planDeclarationConditionRecovery(match,move):null;
    if(recovery&&!recovery.ok)return this.rejectPlayerMove(match,recovery.reason);
    const turnSide=pending.state.turnSide??pending.state.attackingSide;
    const completionPlan=this.planCompletedTurn(match,turnSide,"resolved_battle",pending.state.spinRecordIndex,move);
    if (!completionPlan || !this.pauseMatchClock(match) || !this.appendMove(match,move)) return false;
    const declarationIndex=match.record.all_moves.length-1;
    match.activeBattleResolution.turnCompletionPlan=completionPlan;
    for(const [pokemon,condition] of recovery?.changes??[])match.conditions.set(pokemon,condition);
    this.playerMoveAccepted(match,move,side);
    if(recovery)this.applyConditionRecoverySurround(match,recovery);
    if (type==="null_move") return this.completeBattleResolution(match,pending.state,pending.outcome);
    // Waking the extra defender can surround a battler before any second Spin.
    // The first Spin still owns completion of the original player's turn.
    if(recovery?.cancelled)return this.completeBattleResolution(match,pending.state,pending.outcome);
    // Retire first-battle attachments while retaining its deferred receipt and
    // the original turn. Only the final outcome commits a completed-turn fact.
    if (!this.completeBattleResolution(match,pending.state,pending.outcome,{endTurn:false})) return false;
    match.extraBattle.used=true;
    match.battleResolutionPending=true;
    const declaration={index:declarationIndex,move:clone(move),started:false,turnSide};
    match.activeBattleDeclaration=declaration;
    setTimeout(()=>this.resolveBattle(match,move,declaration),this.moveDelayMs);
    return true;
  }

  scheduleSecondarySpins(match, pending) {
    setTimeout(() => this.performSecondarySpins(match, pending), this.moveDelayMs);
  }

  performSecondarySpins(match, pending = match.pendingSecondarySpins) {
    if (!pending || pending !== match.pendingSecondarySpins || match.pendingKnockouts
        || !currentBattleResolution(match, pending.state, "applying")
        || match.record.all_moves.length !== pending.recordMoveCount) return false;
    if (!this.preflightTurnRecord(match) || !completionCapacityAvailable(match, null, 40)) return false;
    const plan = pending.outcome.secondarySpins[pending.planIndex];
    const spins = [];
    try {
      // Native two-target controls announce ascending targets, then emit the
      // actual probability wheels and Sphere results in reverse order.
      for (const pokemon of [...plan.targets].reverse()) {
        const range = wheelRange(match, pokemon), num = this.spinUnitSource(range, pokemon);
        if (!Number.isInteger(num) || num < 0 || num >= range) throw new Error("invalid_secondary_spin_rng_result");
        const currentCondition = match.conditions.get(pokemon);
        const condition = currentCondition === "faint" ? pending.outcome.conditionsBefore?.[pokemon] : currentCondition;
        spins.push({pokemon, results:[{displace:conditionSpinDisplacement(condition), num, type:"probability"}]});
      }
    } catch (error) { return completionFailure(match, error.message); }
    const move = {display_info:"move", selective_side:"both", value:{type:"spin", spins}};
    const completionPlan = this.planCompletedTurn(match, pending.state.turnSide ?? pending.state.attackingSide, "resolved_battle", match.record.all_moves.length, move);
    if (!completionPlan || !this.appendMove(match, move)) return false;
    pending.state.spinRecordIndex = match.record.all_moves.length-1;
    match.activeBattleResolution.spinRecordIndex = pending.state.spinRecordIndex;
    match.activeBattleResolution.turnCompletionPlan = completionPlan;
    this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
    const targets = spins.filter(spin => Number(selectedSkill(match, spin.pokemon, spin.results[0].num, spin.results[0].displace)?.color) !== 4).map(spin=>spin.pokemon);
    // Ice Shard removes copies attached to these figures, not distant sources
    // whose aura happens to benefit them. Damage already resolved this battle.
    for (const pokemon of targets) disableSphereAttachments(ensurePlateState(match), pokemon);
    logMatchEvent(match, "secondary_spin", {skill:plan.skill, pokemon:plan.pokemon, disable_sphere_targets:targets});
    const next = {...pending, planIndex:pending.planIndex+1, recordMoveCount:match.record.all_moves.length};
    match.pendingSecondarySpins = null;
    if (next.planIndex < pending.outcome.secondarySpins.length) {
      match.pendingSecondarySpins = next;this.scheduleSecondarySpins(match, next);return true;
    }
    const targetsToMove = (pending.outcome.pendingKnockoutTargets || []).map(pokemon=>({pokemon, from:match.positions.get(pokemon)}));
    if (targetsToMove.length) {
      const steps = planKnockoutRelocations(match, targetsToMove);
      if (!steps) return completionFailure(match,"secondary_spin_knockout_disposition_invalid");
      if (targetsToMove.length===1) return this.completeKnockoutBatch(match,pending.state,pending.outcome,steps);
      this.stagePendingKnockouts(match,pending.state,pending.outcome,targetsToMove);return true;
    }
    applyPokepower1326(match, pending.state.attacker, pending.state.defender, pending.outcome.battledBefore);
    return this.completeBattleResolution(match,pending.state,pending.outcome);
  }

  schedulePendingKnockouts(match, pending) {
    setTimeout(() => this.performPendingKnockouts(match, pending), this.moveDelayMs);
  }

  stagePendingKnockouts(match, state, outcome, targets) {
    if (!planKnockoutRelocations(match, targets)?.length) return false;
    // Native legal_moves samples an automatic candidate. The selected move is
    // fixed for this callback and record prefix; later queries may select anew.
    const index = this.knockoutChoiceSource(targets.length);
    if (!Number.isInteger(index) || index < 0 || index >= targets.length) return false;
    const selected = targets[index];
    const step = planKnockoutRelocations(match, [selected])?.[0];
    if (!step) return false;
    let value;
    if (step.excluded !== undefined) value = { pokemons: [step.pokemon], type: "remove_pokemon" };
    else if (step.releasedPokemon !== undefined) value = { pokemon: step.releasedPokemon, type: "bench_move" };
    else if (step.upperPokemon !== undefined) value = { from: step.upper, to: step.lower, type: "spot_move" };
    else value = { from: selected.from, to: step.upper, type: "knockedout_move" };
    const pending = { state: clone(state), outcome, recordMoveCount: match.record.all_moves.length,
      targets, selectedPokemon: selected.pokemon, shiftPokemon: step.upperPokemon,
      firstMove: { selective_side: "both", value } };
    match.pendingKnockouts = pending;
    match.pendingRespin = null;
    match.battleResolutionPending = true;
    this.schedulePendingKnockouts(match, pending);
    return true;
  }

  performPendingKnockouts(match, pending = match.pendingKnockouts, move = pending?.firstMove) {
    if (match.phase !== "started" || !pending || pending !== match.pendingKnockouts
        || !currentBattleResolution(match, pending.state, "applying")
        || match.record.all_moves.length !== pending.recordMoveCount
        || move?.selective_side !== "both" || !move.value || Array.isArray(move.value)
        || Object.keys(move.value).length !== Object.keys(pending.firstMove.value).length
        || Object.keys(pending.firstMove.value).some(key => JSON.stringify(move.value[key]) !== JSON.stringify(pending.firstMove.value[key]))) return false;
    const selected = pending.targets.find(target => target.pokemon === pending.selectedPokemon);
    const remaining = pending.targets.filter(target => target !== selected);
    const steps = selected && planKnockoutRelocations(match, [selected, ...remaining]);
    if (!steps) return false;
    const type = moveType(move), first = steps[0];
    if (type === "bench_move" && first.releasedPokemon !== move.value.pokemon) return false;
    if (type === "spot_move" && (first.upperPokemon !== pending.shiftPokemon || first.releasedPokemon !== undefined
        || match.positions.get(pending.shiftPokemon) !== move.value.from || [...match.positions.values()].includes(move.value.to))) return false;
    if (type === "remove_pokemon" && first.excluded === undefined) return false;
    if (type === "knockedout_move" && (first.excluded !== undefined || first.upperPokemon !== undefined
        || match.positions.get(selected.pokemon) !== move.value.from || first.upper !== move.value.to)) return false;
    if (!completionCapacityAvailable(match, move, pending.targets.length * 3 + 3)) return false;
    const completionPlan = this.planCompletedTurn(match, pending.state.turnSide ?? pending.state.attackingSide, "resolved_battle", pending.state.spinRecordIndex, move);
    if (!completionPlan || !this.appendMove(match, move)) return false;
    match.activeBattleResolution.turnCompletionPlan = completionPlan;
    this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
    match.pendingKnockouts = null;
    if (type === "spot_move" || type === "bench_move") {
      if (type === "spot_move") match.positions.set(pending.shiftPokemon, move.value.to);
      else {
        const pokemon = first.releasedPokemon;
        match.positions.set(pokemon, 28 + pokemon);
        match.battledAfterField.set(pokemon, false);
        match.conditions.set(pokemon, "normal"); match.triangles.set(pokemon, "empty");
        match.disabledSkills.delete(pokemon);
        applyWait(match.record, match.waits, pokemon, 2);
      }
      return this.stagePendingKnockouts(match, pending.state, pending.outcome, pending.targets);
    }
    if (remaining.length > 1) {
      if (!this.completeKnockoutBatch(match, pending.state, pending.outcome, steps.slice(0, 1), { complete: false })) return false;
      return this.stagePendingKnockouts(match, pending.state, pending.outcome, remaining);
    }
    // The last faint figure resolves inline, including all Center preparation.
    return this.completeKnockoutBatch(match, pending.state, pending.outcome, steps);
  }

  completeKnockoutBatch(match, state, outcome, steps, { complete = true } = {}) {
    // Relocation and KO awards mutate before finalization. Guard this entry,
    // not just completeBattleResolution, so replayed/stale continuations
    // cannot consume the final result twice or shift an occupied P.C. again.
    if (!currentBattleResolution(match, state, "applying") || !Array.isArray(steps) || !steps.length) return false;
    const remaining = (outcome.pendingKnockoutTargets || []).filter(pokemon => !(outcome.knockoutPokemons || []).includes(pokemon));
    if (new Set(steps.map(step => step.pokemon)).size !== steps.length || steps.some(step => !remaining.includes(step.pokemon))) return false;
    const expected = planKnockoutRelocations(match, steps.map(({ pokemon }) => ({ pokemon, from: match.positions.get(pokemon) })));
    if (!expected || JSON.stringify(expected) !== JSON.stringify(steps)) return false;
    const plan = match.activeBattleResolution.turnCompletionPlan;
    const checked = this.preflightTurnRecord(match);
    if (!plan?.ok || !checked) return false;
    const verified = commitCompletion(checked.state, plan.cause, match.record);
    if (!verified.ok || !verified.changed) return completionFailure(match, verified.reason || "completion_already_claimed");
    for (const step of steps) {
      const { pokemon } = step;
      applyKnockoutRelocation(match, step);
      if (step.excluded === undefined) this.applyZGaugeAwards(match, [{ cause: outcome.knockoutGaugeCause || "rock_slide_knockout", deltas: {
        black: 0, white: 0, [sideForPokemon(pokemon)]: 10,
      } }]);
      match.conditions.set(pokemon, "normal");
      match.disabledSkills.delete(pokemon);
    }
    outcome.knockoutAwardsApplied = true;
    outcome.knockout = steps.length > 0;
    outcome.knockoutPokemons = [...(outcome.knockoutPokemons || []), ...steps.map(({ pokemon }) => pokemon)];
    if (!complete) return true;
    applyPokepower1326(match, Number(state.attacker), Number(state.defender), outcome.battledBefore);
    return this.completeBattleResolution(match, state, outcome);
  }

  completeBattleResolution(match, state, outcome, {endTurn = true} = {}) {
    if (!currentBattleResolution(match, state, "applying")) return false;
    if ((outcome.pendingKnockoutTargets || []).some(pokemon => !(outcome.knockoutPokemons || []).includes(pokemon))) return false;
    const completionPlan = match.activeBattleResolution.turnCompletionPlan;
    const checked = this.preflightTurnRecord(match);
    if (!completionPlan?.ok || !checked) return false;
    const verified = commitCompletion(checked.state, completionPlan.cause, match.record);
    if (!verified.ok || !verified.changed) return completionFailure(match, verified.reason || "completion_already_claimed");
    const attacker = Number(state.attacker);
    const defender = Number(state.defender);
    const attackingSide = String(state.attackingSide);
    const attackerUnit = Number(state.attackerUnit);
    const defenderUnit = Number(state.defenderUnit);
    const facts = {
      attacker, defender, finalized: true,
      zBattleOutcome: outcome.winner === attacker ? "win" : outcome.winner < 0 ? "draw" : "lose",
      attackingSide,
      attackerColor: Number(outcome.attackerSkill.color),
      defenderColor: Number(outcome.defenderSkill.color),
      knockoutSide: outcome.knockout && !outcome.excluded && !outcome.knockoutAwardsApplied ? sideForPokemon(outcome.loser) : null,
    };
    let completed = null;
    try { if (ensureZState(match).active) completed = finishZBattle(match.zState, facts); }
    catch (error) { return completionFailure(match, String(error.message)); }
    const settledSurround=planConditionRecovery(match,[],true);
    if(!settledSurround.ok)return completionFailure(match,settledSurround.reason);
    const afterSurround=turnRuleProjection(match);
    for(const step of settledSurround.steps){applyKnockoutRelocation(afterSurround,step);afterSurround.conditions.set(step.pokemon,'normal');afterSurround.disabledSkills.delete(step.pokemon);}
    const thawTargets=[attacker,defender].filter(pokemon=>afterSurround.positions.get(pokemon)<28&&afterSurround.conditions.get(pokemon)==='melt');
    const thaw=thawTargets.length?planConditionRecovery(afterSurround,thawTargets.map(pokemon=>[pokemon,'normal']),true):null;
    if(thaw&&!thaw.ok)return completionFailure(match,thaw.reason);
    // Claim only after the ledger and known Z settlement plans validate.
    match.activeBattleResolution.phase = "completed";
    this.applyMovementSurround(match,settledSurround);
    for(const step of settledSurround.steps)if(step.excluded===undefined)this.applyZGaugeAwards(match,[{
      cause:'battle_surround_knockout',deltas:{black:0,white:0,[sideForPokemon(step.pokemon)]:10}}]);
    if(thaw){
      for(const [pokemon,condition] of thaw.changes)match.conditions.set(pokemon,condition);
      this.applyConditionRecoverySurround(match,thaw);
    }
    if (completed) {
      this.applyZGaugeAwards(match, completed.gaugeCauses);
      match.zState = completed.state;
    } else if(endTurn) {
      const awards=completedBattleGaugeAwards(facts);
      this.applyZGaugeAwards(match,awards);
      // Original ARM extra-battle controls reuse the final battle's attacker
      // and resolved Miss colors for each held receipt, even on a defender's
      // extra attack. A knockout receipt is independent and is never repeated.
      const held=match.extraBattle?.deferredSettlements??0;
      for(let index=0;index<held;index++)this.applyZGaugeAwards(match,awards.filter(award=>award.cause==='resolved_battle_and_final_miss'));
    } else if(match.extraBattle) {
      match.extraBattle.deferredSettlements=(match.extraBattle.deferredSettlements??0)+1;
    }
    completePlateBattle(ensurePlateState(match), [attacker, defender], {includeOneBattlePlates:true});
    if (endTurn) {
      if (!this.completeTurn(match, state.turnSide ?? attackingSide, completionPlan)) return false;
      this.applyZGaugeAwards(match, [turnStartGaugeAward(match.turn, match.positions, FIELD_POINT_Z)]);
    } else {
      // One battle has settled, but Double Flight keeps this same turn open.
      // Battle-only attachments and disabled-wheel selections do not leak
      // into the second battle. Wait/turn-duration cleanup stays deferred.
      for (const pokemon of [attacker,defender]) {match.damageBonuses.delete(pokemon);match.disabledSkills.delete(pokemon);}
      match.pendingPlate=null;match.pendingRespin=null;match.pendingJump=null;match.pendingExtraBattle=null;
      match.pendingBattles=[];match.battleResolutionPending=false;
    }
    logMatchEvent(match, "battle_spin", {
      attacker,
      defender,
      attacker_unit: attackerUnit,
      defender_unit: defenderUnit,
      attacker_skill_id: Number(outcome.attackerSkill?.id ?? -1),
      defender_skill_id: Number(outcome.defenderSkill?.id ?? -1),
      winner: outcome.winner,
      loser: outcome.loser,
      knockout: outcome.knockout,
      turn_completed: endTurn,
      turn_side: state.turnSide ?? attackingSide,
      knockout_pokemons: outcome.knockoutPokemons ?? (outcome.knockout ? [outcome.loser] : []),
      evidence_mode: state.evidenceMode ?? "off",
      conditions: conditionSnapshot(match),
      waits: waitSnapshot(match),
    });
    if (endTurn && match.turn === "white") setTimeout(() => this.playOpponentTurn(match), this.opponentTurnDelayMs);
    return true;
  }

  applyBaseBattleOutcome(match, attacker, defender, attackerUnit, defenderUnit, spins = null) {
    const colorActions = battleColorActions(match.record, match.positions, match.battledAfterField, attacker, defender, FIELD_EDGES, match.turn);
    const left = spins?.has(attacker) ? selectedSpinSkill(match, attacker, spins.get(attacker), colorActions) : selectedSkill(match, attacker, attackerUnit, conditionSpinDisplacement(match.conditions.get(attacker)), colorActions);
    const right = spins?.has(defender) ? selectedSpinSkill(match, defender, spins.get(defender), colorActions) : selectedSkill(match, defender, defenderUnit, conditionSpinDisplacement(match.conditions.get(defender)), colorActions);
    applyPurpleStars(match.record, match.positions, match.battledAfterField, attacker, left, match.turn);
    applyPurpleStars(match.record, match.positions, match.battledAfterField, defender, right, match.turn);
    applyConditionBattleDamage(match, attacker, defender, left);
    applyConditionBattleDamage(match, defender, attacker, right);
    // Keep the trigger's entry state through all deferred spins and Center
    // movement. KO cleanup resets the live marker for a later field entry;
    // that reset must not turn this very battle into a new first battle.
    const battledBefore = Object.fromEntries([attacker, defender].map(pokemon => [pokemon, !!match.battledAfterField.get(pokemon)]));
    const result = { attackerSkill: left, defenderSkill: right, winner: -1, loser: -1, knockout: false, battledBefore, conditionsBefore: conditionSnapshot(match) };
    const battleConditions = new Map(match.conditions), battleWaits = new Map(match.waits);
    const remainingAfterDisguise = targets => {
      const protectedTargets=consumeDisguiseMarkers(match,targets);
      if (protectedTargets.length) result.disguiseTargets=[...(result.disguiseTargets??[]),...protectedTargets];
      return targets.filter(pokemon=>!protectedTargets.includes(pokemon));
    };
    if (!left || !right) return result;
    result.secondarySpins = iceShardSpinPlans(match, attacker, defender, left, right);
    const winnerSlot = baseSkillWinner(left, right);
    const fainted = applyRockSlide1140(match, attacker, defender, left, right, winnerSlot);
    if (fainted.length) {
      // Native two-target draw: skill effects finish, but relocation, awards,
      // post-battle abilities and turn completion wait for the both command.
      result.pendingKnockoutTargets = remainingAfterDisguise(fainted);
      if (!result.pendingKnockoutTargets.length && !result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
      return result;
    }
    if (winnerSlot < 0) {
      if (!result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
      return result;
    }
    result.winner = winnerSlot === 0 ? attacker : defender;
    result.loser = winnerSlot === 0 ? defender : attacker;
    const winnerSkill = winnerSlot === 0 ? left : right;
    const loserSkill = winnerSlot === 0 ? right : left;
    const jump = purpleJumpPlan(match.positions, result.winner, result.loser, winnerSkill, FIELD_EDGES,
      {record:match.record,conditions:battleConditions,turn:match.turn});
    if (jump) {
      // Preserve both unresolved continuations. Their native ordering is not
      // established; allowing landing here would silently discard Ice Shard.
      if (result.secondarySpins.length) {
        jump.targets = [];
        jump.unresolved_reason = jump.skill === 1520 ? "double_flight_secondary_spin_order_unverified" : "fly_secondary_spin_order_unverified";
      }
      result.pendingJump = jump; return result;
    }
    const effectPlan = purpleEffectKnockoutPlan(match.record, match.positions, battleConditions, result.winner, result.loser, winnerSkill, loserSkill, match.turn, FIELD_EDGES, battleWaits);
    if (effectPlan) {
      result.effectKnockoutPlan = effectPlan;
      const targets = effectPlan.targets.map(pokemon => ({pokemon, from:match.positions.get(pokemon)}));
      if (targets.length && !planKnockoutRelocations(match, targets, {requireFaint:false})) throw new Error("invalid_effect_knockout_disposition");
      // Conditional KO predicates read the original state above. The separate
      // Wait applies even when the predicate or protection prevents the KO.
      for (const pokemon of effectPlan.wait_targets ?? []) applyWait(match.record,match.waits,pokemon,effectPlan.wait);
      if (effectPlan.targets.length) {
        for (const pokemon of effectPlan.targets) match.conditions.set(pokemon,"faint");
        const replacementOrder=[1044,1051].includes(Number(winnerSkill.id)) ? [result.winner,result.loser].filter(p=>effectPlan.targets.includes(p)) : effectPlan.targets;
        result.pendingKnockoutTargets = remainingAfterDisguise(replacementOrder);
        if (!result.pendingKnockoutTargets.length && !result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
        result.knockoutGaugeCause = "base_battle_knockout";
        return result;
      }
    }
    if (Number(winnerSkill.id) === 1479 && Number(winnerSkill.color) === 2) {
      result.curse = { pokemon: result.loser, overwritten: match.triangles.get(result.loser) === "curse" };
      match.triangles.set(result.loser, "curse");
    }
    const benchPlan = benchAttackPlan(match.record, match.positions, result.winner, result.loser, winnerSkill, FIELD_EDGES);
    if (benchPlan) {
      result.benchTransfer = benchPlan;
      for (const transfer of benchPlan.transfers) if (transfer.blocked_by === null) {
        match.positions.set(transfer.pokemon, transfer.to);
        match.conditions.set(transfer.pokemon, "normal");
        match.triangles.set(transfer.pokemon, "empty");
        match.disabledSkills.delete(transfer.pokemon);
        match.battledAfterField.set(transfer.pokemon, false);
      }
      // The text has a separate Wait clause. Its interaction with protected
      // movement is description-derived and still needs a native contrast.
      for (const pokemon of benchPlan.wait_targets) applyWait(match.record,match.waits,pokemon, benchPlan.wait);
    }
    // Grass Knot1452 replaces its own damage KO when the opposing attack is
    // at least120. The displayed damage winner remains unchanged.
    if (Number(loserSkill.id) === 1452 && [1, 3].includes(Number(winnerSkill.color))
        && Number(winnerSkill.speed_or_damage) >= 120) {
      // A prevented replacement does not reinstate the damage KO of Grass
      // Knot's holder. The Attack text replaces that KO before prevention.
      if (effectKnockoutProtectionSources(match.record, match.positions, match.conditions, result.winner, result.loser, match.turn, FIELD_EDGES).length) {
        result.effectKnockoutPrevented = true;
        if (!result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
        return result;
      }
      match.conditions.set(result.winner, "faint");
      result.pendingKnockoutTargets = remainingAfterDisguise([result.winner]);
      if (!result.pendingKnockoutTargets.length && !result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
      result.knockoutGaugeCause = "base_battle_knockout";
      return result;
    }
    const waiting = purpleWaitPlan(match.record, match.positions, result.winner, result.loser, winnerSkill, FIELD_EDGES);
    if (waiting) {
      result.purpleWaitPlan = waiting;
      for (const target of waiting.condition_targets) match.conditions.set(target, waiting.condition);
      // The printed Wait clause is independent of status prevention. Targets
      // are selected once from the field before any effects are committed.
      for (const target of waiting.wait_targets) applyWait(match.record,match.waits,target, waiting.wait);
    }
    const conditionPlan = purpleConditionPlan(match.record, match.positions, result.winner, result.loser, winnerSkill, FIELD_EDGES, match.plateState);
    if (conditionPlan) {
      result.purpleConditionPlan = conditionPlan;
      for (const target of conditionPlan.condition_targets) {
        match.conditions.set(target,conditionPlan.condition);
      }
    }
    const status = PURPLE_STATUS_ATTACKS.get(Number(winnerSkill.id));
    if (Number(winnerSkill.color) === 2 && status) {
      const targets = Number(winnerSkill.id) === 1020 ? [result.winner, result.loser] : [result.loser];
      for (const target of targets) {
        if (!conditionImmunitySources(match.record, match.positions, target, status, FIELD_EDGES).length
            && spherePreventionPlate(match.record, match.positions, match.plateState, target, status, FIELD_EDGES) < 0) {
          match.conditions.set(target, status);
        }
      }
    }

    // Native1715 White and archived Black controls: this Purple success marks
    // only the battle opponent faint and resolves its P.C. insertion inline.
    // Keep the existing Wait; unlike Rock Slide it does not assign Wait3.
    // The shared KO transaction then emits its award before final Z spending.
    if (Number(winnerSkill.id) === 1715) {
      if (effectKnockoutProtectionSources(match.record, match.positions, match.conditions, result.loser, result.winner, match.turn, FIELD_EDGES).length) {
        result.effectKnockoutPrevented = true;
        if (!result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
        return result;
      }
      match.conditions.set(result.loser, "faint");
      result.pendingKnockoutTargets = remainingAfterDisguise([result.loser]);
      if (!result.pendingKnockoutTargets.length && !result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
      result.knockoutGaugeCause = "base_battle_knockout";
      return result;
    }

    // Fresh native1717 mirrored/adjacent controls: target plus its neighboring
    // opposing figures receive Wait9; friendly neighbors are excluded. A tie
    // emits no skill/Wait effect. The turn boundary later decrements9 to8.
    if (Number(winnerSkill.id) === 1717) {
      const adjacent = new Set(BOARD_GRAPH.get(match.positions.get(result.loser)) || []);
      for (const [pokemon, point] of match.positions) {
        if (sideForPokemon(pokemon) === sideForPokemon(result.loser) && point >= 0 && point < 28
            && (pokemon === result.loser || adjacent.has(point))) applyWait(match.record,match.waits,pokemon, 9);
      }
    }

    // Blue skill 1127 assigns Wait 2 to its owner.  The native engine applies
    // this before later post-battle Pokepowers, so a subsequent Wait action may
    // deliberately replace it (as 1326 does in the owned figure-6 matrix).
    if (Number(winnerSkill.id) === 1127) applyWait(match.record,match.waits,result.winner, 2);

    const canKnockOut = [1, 3].includes(Number(winnerSkill.color)) && Number(winnerSkill.speed_or_damage) > 0 && Number(loserSkill.color) !== 4;
    if (canKnockOut && !remainingAfterDisguise([result.loser]).length) {
      if (!result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);
      return result;
    }
    if (canKnockOut) {
      const loser = result.loser;
      if (result.secondarySpins.length) {
        match.conditions.set(loser,"faint");result.pendingKnockoutTargets=[loser];
        result.knockoutGaugeCause="base_battle_knockout";return result;
      }
      const relocation = planKnockoutRelocations(match, [{ pokemon: loser, from: match.positions.get(loser) }], { requireFaint: false });
      if (relocation) {
        applyKnockoutRelocation(match, relocation[0]);
        match.conditions.set(loser, "normal");
        result.excluded = relocation[0].excluded !== undefined;
        if (!result.excluded && Number(winnerSkill.id) === 1536) applyWait(match.record,match.waits,loser, 2);
        result.knockout = true;
      }
    }

    // The native first-battle matrix includes retaliation after the owner is
    // knocked out, but excludes an opponent already moved to the Center.
    // The per-figure marker prevents this first-battle trigger from repeating.
    if (!result.secondarySpins.length) applyPokepower1326(match, attacker, defender, result.battledBefore);

    if (!canKnockOut) return result;
    return result;
  }

  applyMovementSurround(match, plan) {
    for (const pokemon of plan.disguiseEntry??[]) match.triangles.set(pokemon,"bake_no_kawa");
    if (plan.entryRecovery?.length) {
      applyFieldEntryRecovery(match, plan.entryRecovery);
      logMatchEvent(match, "field_entry_recovery", {recoveries: plan.entryRecovery});
    }
    if (!plan.targets.length) return;
    for (const pokemon of plan.targets) match.conditions.set(pokemon, "faint");
    for (const step of plan.steps) {
      applyKnockoutRelocation(match, step);
      match.conditions.set(step.pokemon, "normal");
      match.disabledSkills.delete(step.pokemon);
    }
    // Surrounding is not a battle. No battle completion, Attack prevention,
    // first-battle ability or plate-battle cleanup is fabricated here. The
    // nonbattle KO gauge amount is still unobserved and is not awarded yet.
    logMatchEvent(match, "movement_surround", {targets: plan.targets, candidates: plan.candidates,
      positions: Object.fromEntries(match.positions), conditions: conditionSnapshot(match), waits: waitSnapshot(match)});
  }

  playOpponentTurn(match) {
    if (match.phase !== "started" || match.turn !== "white" || !match.socket) return;
    const admittedRecord = this.preflightTurnRecord(match);
    if (!admittedRecord || admittedRecord.state.completed_turns >= MAX_COMPLETIONS || !completionCapacityAvailable(match)) return;
    const move = match.pendingTouch ? chooseOpponentMove(match) : (this.chooseObservedOpponentPlate(match) ?? chooseOpponentMove(match));
    if (!move) return this.finish(match, "black", "no_legal_moves");
    const type = moveType(move);
    if (type === "touch") return this.acceptTouchRecovery(match,move,"white",true);
    if (type === "declare_battle") {
      if (!validateBattleDeclaration(match, "white", move)) return this.finish(match, "black", "invalid_opponent_battle");
      const recovery=planDeclarationConditionRecovery(match,move);
      if(recovery&&!recovery.ok)return completionFailure(match,recovery.reason);
      const completion=recovery?.cancelled?this.planCompletedTurn(match,'white','declaration_surround',match.record.all_moves.length,move):null;
      if(recovery?.cancelled&&!completion)return false;
      if (!this.appendMove(match, move)) return;
      const declarationIndex=match.record.all_moves.length-1;
      for(const [pokemon,condition] of recovery?.changes??[])match.conditions.set(pokemon,condition);
      match.battleResolutionPending = true;
      logMatchEvent(match, "opponent_move", { move_type: type, attacker: Number(move.value.from_pokemon), defender: Number(move.value.to_pokemon) });
      this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
      if(recovery)this.applyConditionRecoverySurround(match,recovery);
      if(recovery?.cancelled){
        if(!this.completeTurn(match,'white',completion))return false;
        this.applyZGaugeAwards(match,[turnStartGaugeAward(match.turn,match.positions,FIELD_POINT_Z)]);
        return true;
      }
      match.pendingTouch=null;
      const declaration = { index: declarationIndex, move: clone(move), started: false };
      match.activeBattleDeclaration = declaration;
      setTimeout(() => this.resolveBattle(match, move, declaration), this.moveDelayMs);
      return;
    }
    if (type === "declare_plate") {
      if (!validatePlateMove(match, "white", move)) return this.finish(match, "black", "invalid_opponent_plate");
      const surround = ["spot_move", "swap_move"].includes(nestedPlateType(move)) ? planMovementSurround(match, move) : null;
      if (surround && !surround.ok) return this.rejectPlayerMove(match, surround.reason);
      const kind = completionKind(move);
      const completionPlan = kind ? this.planCompletedTurn(match, "white", kind, match.record.all_moves.length, move) : null;
      if ((kind && !completionPlan) || !this.appendMove(match, move)) return;
      applyPositionMove(match, move);
      match.opponentPlateUsed = true;
      const nested = move.value?.value || {};
      logMatchEvent(match, "opponent_plate", {
        move_type: type,
        plate_id: Number(move.value?.plate_id ?? -1),
        nested_type: String(nested.type || ""),
        from: Number(nested.from ?? -1),
        to: Number(nested.to ?? -1),
        pokemon: Number(nested.pokemon ?? nested.pokemons?.[0] ?? -1),
      });
      this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
      if (surround) this.applyMovementSurround(match, surround.grudgeEntry>=0?{...surround,targets:[]}:surround);
      if (surround?.grudgeEntry>=0) return this.stagePendingGrudge(match,"white",surround.grudgeEntry,move,match.record.all_moves.length-1);
      const nestedType = String(nested.type || "");
      if (!SUPPORTED_SPHERE_IDS.includes(Number(move.value.plate_id)) && ["select_pokemon", "select_pokemon_and_declare_aura", "put_circle"].includes(nestedType)) {
        const pokemon = nestedType === "put_circle" ? Number(nested.pokemons?.[0]) : Number(nested.pokemon);
        match.pendingPlate = { side: "white", plateId: Number(move.value.plate_id), pokemon };
        if (Number(move.value.plate_id) === 5022) match.damageBonuses.set(pokemon, 30);
        if (nestedType === "put_circle") {
          const point = match.positions.get(pokemon);
          const occupiedOpponent = pokemonForSideAtPoint(match, point, "black");
          match.pendingBattles = pendingBattlesAfterMovement(match, "white", pokemon, point, occupiedOpponent);
        }
        setTimeout(() => this.playOpponentTurn(match), this.opponentPlateContinuationDelayMs);
        return;
      }
      if (!moveEndsTurn(move)) {
        setTimeout(() => this.playOpponentTurn(match), this.moveDelayMs);
        return;
      }
      if (!this.completeTurn(match, "white", completionPlan)) return;
      this.applyZGaugeAwards(match, [turnStartGaugeAward(match.turn, match.positions, FIELD_POINT_Z)]);
      logMatchEvent(match, "opponent_turn_end", {
        conditions: conditionSnapshot(match),
        waits: waitSnapshot(match),
      });
      return;
    }
    if (type === "spot_move") {
      if (!validateBenchEntryMove(match,"white",move)) return this.finish(match,"black","invalid_opponent_spot_move");
      const surround=planMovementSurround(match,move);
      const completionPlan=this.planCompletedTurn(match,"white","nonbattle_spot_move",match.record.all_moves.length,move);
      if (!surround.ok || !completionPlan || !this.appendMove(match,move)) return;
      applyPositionMove(match,move);
      this.sendSequenced(match,`do_move ${JSON.stringify(move)}`);
      this.applyMovementSurround(match,surround);
      if (!this.completeTurn(match,"white",completionPlan)) return;
      this.applyZGaugeAwards(match,[turnStartGaugeAward(match.turn,match.positions,FIELD_POINT_Z)]);
      return;
    }
    if (!validateMovement(match, "white", move)) return this.finish(match, "black", "invalid_opponent_movement");
    const route = movementRoute(move);
    const destination = route.at(-1);
    const movingPokemon = pokemonForSideAtPoint(match, route[0], "white");
    const occupiedPokemon = pokemonForSideAtPoint(match, destination, "black");
    const surround = planMovementSurround(match, move);
    if (!surround.ok) return this.rejectPlayerMove(match, surround.reason);
    const completionPlan = this.planCompletedTurn(match, "white", "nonbattle_mp_move", match.record.all_moves.length, move);
    if (!completionPlan || !this.appendMove(match, move)) return;
    applyPositionMove(match, move);
    if (match.pendingPlate?.side !== "white" || match.pendingPlate?.pokemon !== movingPokemon) {
      match.pendingPlate = null;
    }
    logMatchEvent(match, "opponent_move", { move_type: type, route });
    this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
    this.applyMovementSurround(match, surround.grudgeEntry>=0?{...surround,targets:[]}:surround);
    if (destination === 24 && match.positions.get(movingPokemon) === destination) return this.finish(match, "white", "goal");
    if (surround.grudgeEntry>=0) return this.stagePendingGrudge(match,"white",surround.grudgeEntry,move,match.record.all_moves.length-1);
    match.pendingBattles = pendingBattlesAfterMovement(
      match,
      "white",
      movingPokemon,
      destination,
      occupiedPokemon >= 0 && sideForPokemon(occupiedPokemon) === "black" ? occupiedPokemon : -1,
      true,
    );
    const touchPending=this.stagePendingTouch(match,"white",movingPokemon);
    if (match.pendingBattles.length > 0 || touchPending) {
      setTimeout(() => this.playOpponentTurn(match), this.moveDelayMs);
      return;
    }
    if (!this.completeTurn(match, "white", completionPlan)) return;
    this.applyZGaugeAwards(match, [turnStartGaugeAward(match.turn, match.positions, FIELD_POINT_Z)]);
    logMatchEvent(match, "opponent_turn_end", {
      conditions: conditionSnapshot(match),
      waits: waitSnapshot(match),
    });
  }

  chooseObservedOpponentPlate(match) {
    if (this.opponentPlateMode === "off" || match.opponentPlateUsed) return null;
    if (this.opponentPlateMode === "native_white_full_heal_once") {
      for (let pokemon = 6; pokemon < 12; pokemon += 1) {
        if (!["sleep", "paralyze"].includes(String(match.conditions.get(pokemon)))) continue;
        const move = {
          display_info: "move",
          selective_side: "white",
          value: {
            plate_id: 5002,
            type: "declare_plate",
            value: { condition: "normal", pokemons: [pokemon], type: "put_circle" },
          },
        };
        if (validatePlateMove(match, "white", move)) return move;
      }
      return null;
    }
    // addZGauge appends a server-owned `neither` move at every turn boundary
    // before this opponent callback runs. Recover the immediately preceding
    // player action instead of assuming the physical last record entry is the
    // DeclarePlate that opened the controlled native branch.
    const opening = match.record.all_moves.slice().reverse().find(
      (candidate) => String(candidate?.selective_side || "") === "black",
    );
    const nested = opening?.value?.value || {};
    if (String(opening?.selective_side || "") !== "black"
        || moveType(opening) !== "declare_plate"
        || Number(opening?.value?.plate_id) !== 5026
        || String(nested.type || "") !== "spot_move"
        || Number(nested.from) !== 28
        || Number(nested.to) !== 16) return null;
    const move = this.opponentPlateMode === "native_white_air_balloon_once" ? {
      display_info: "move",
      selective_side: "white",
      value: {
        plate_id: 5426,
        type: "declare_plate",
        value: { pokemon: 6, type: "select_pokemon_and_declare_aura" },
      },
    } : {
      display_info: "move",
      selective_side: "white",
      value: { plate_id: 5026, type: "declare_plate", value: { from: 34, to: 1, type: "spot_move" } },
    };
    return validatePlateMove(match, "white", move) ? move : null;
  }

  chooseObservedBattleSpinUnits(match, attacker, defender) {
    if (match.battleEvidenceUsed) return null;
    if (this.battleEvidenceMode === "native_bridge_1227_speedup_once") {
      // Native bridge record 224417 plus the controlled libTFG spin fixture
      // prove the complete declaration and resolution path: defender 0's
      // Pokepower 1227 promotes White 1372/unit 20 to Gold before attacker
      // 6's Purple 1057/unit 8 is compared against it.
      if (new Set([Number(attacker), Number(defender)]).size !== 2
          || ![Number(attacker), Number(defender)].every((pokemon) => [0, 6].includes(pokemon))) return null;
      match.battleEvidenceUsed = true;
      return {
        mode: this.battleEvidenceMode,
        attackerUnit: Number(attacker) === 6
          ? Number(pokepower1227Contract.controlled_units.attacker)
          : Number(pokepower1227Contract.controlled_units.defender),
        defenderUnit: Number(defender) === 0
          ? Number(pokepower1227Contract.controlled_units.defender)
          : Number(pokepower1227Contract.controlled_units.attacker),
      };
    }
    if (this.battleEvidenceMode === "native_black_purple_1085_sleep_white_once") {
      // Exact native-engine fixture: black Pokemon 0/unit 94 selects Purple
      // 1085 while white Pokemon 6/unit 46 selects White 1621. The native
      // effect batch puts Pokemon 6 to sleep before the white turn begins.
      if (new Set([Number(attacker), Number(defender)]).size !== 2
          || ![Number(attacker), Number(defender)].every((pokemon) => [0, 6].includes(pokemon))) return null;
      match.battleEvidenceUsed = true;
      return {
        mode: this.battleEvidenceMode,
        attackerUnit: Number(attacker) === 0 ? 94 : 46,
        defenderUnit: Number(defender) === 6 ? 46 : 94,
      };
    }
    if (this.battleEvidenceMode !== "native_white_blue_1620_paralysis_once") return null;
    // Exact native-engine fixture: white Pokemon 6/unit 93 selects Blue 1620;
    // black Pokemon 0/unit 90 selects Purple 1085. Native output then emits
    // battle_result, Pokepower 1326 notices, paralysis, Wait 3, and turn_end.
    if (Number(attacker) !== 6 || Number(defender) !== 0) return null;
    match.battleEvidenceUsed = true;
    return {
      mode: this.battleEvidenceMode,
      attackerUnit: 93,
      defenderUnit: 90,
    };
  }

  finish(match, winner, reason) {
    if (match.phase === "finished") return;
    match.phase = "finished";
    match.winner = winner;
    match.reason = reason;
    match.activeClockSide = "";
    match.clockStartedAtMs = 0;
    logMatchEvent(match, "match_finish", { winner, reason });
    this.sendSequenced(match, `match_finish ${winner} ${reason}`);
  }

  sendSequenced(match, command) {
    if (this.closeRevokedTrainingSocket(match)) return;
    if (!match.socket || match.socket.destroyed) return;
    match.serverSendIndex += 1;
    match.socket.write(`sequence ${match.serverSendIndex} ${match.clientSendIndex} ${command}\n`);
  }

  startMatchClock(match, side) {
    if (match.phase !== "started" || this.selectionSide(match) !== side) return false;
    this.syncMatchClock(match);
    if (match.phase === "finished") return false;
    match.activeClockSide = side;
    match.clockStartedAtMs = Number(this.clockSource());
    match.lastTimeBroadcastSecond = Math.ceil(Number(match[`${side}TimeMs`]) / 1000);
    return true;
  }

  pauseMatchClock(match) {
    this.syncMatchClock(match);
    if (match.phase === "finished") return false;
    match.activeClockSide = "";
    match.clockStartedAtMs = 0;
    return true;
  }

  syncMatchClock(match) {
    const side = String(match.activeClockSide || "");
    if (!['black', 'white'].includes(side) || match.phase !== "started") return true;
    const now = Number(this.clockSource());
    const elapsed = Math.max(0, now - Number(match.clockStartedAtMs));
    if (elapsed <= 0) return true;
    const key = `${side}TimeMs`;
    match[key] = Math.max(0, Number(match[key] || 0) - elapsed);
    match.clockStartedAtMs = now;
    if (match[key] <= 0) {
      this.finish(match, otherSide(side), "timeout");
      return false;
    }
    return true;
  }

  tickMatchTimers() {
    for (const match of this.matches.values()) {
      this.closeRevokedTrainingSocket(match);
      if (!this.syncMatchClock(match) || match.phase !== "started") continue;
      const side = String(match.activeClockSide || "");
      if (!['black', 'white'].includes(side)) continue;
      const value = Math.max(0, Math.ceil(Number(match[`${side}TimeMs`] || 0)));
      const second = Math.ceil(value / 1000);
      if (second === match.lastTimeBroadcastSecond) continue;
      match.lastTimeBroadcastSecond = second;
      this.sendSequenced(match, `time ${side} ${value}`);
    }
  }

  sessionIsAuthorized(session, userId) {
    if (this.authenticateSession == null) return true;
    try {
      const authenticated = this.authenticateSession(session);
      const id = Number(authenticated?.user_id);
      return Number.isSafeInteger(id) && id > 0 && id === Number(userId);
    } catch {
      return false;
    }
  }

  closeRevokedTrainingSocket(match) {
    // Human matches override per-peer authority; their match.socket is only an
    // internal rule-continuation handle, not an authenticated connection.
    if (match.peers || !match.socket || this.sessionIsAuthorized(match.session, match.localUser?.user_id)) return false;
    const socket = match.socket;
    match.socket = null;
    socket.destroy();
    return true;
  }

  applyZGaugeAwards(match, awards) {
    for (const { cause, deltas, absolute } of awards) this.addZGauge(match, deltas, cause, absolute);
  }

  addZGauge(match, deltas, cause = "explicit_delta", absolute = null) {
    if (match.phase !== "started") return null;
    if (!this.preflightTurnRecord(match)) return null;
    const before = { black: Number(match.zGauge.black || 0), white: Number(match.zGauge.white || 0) };
    let next = { ...before };
    for (const side of ['black', 'white']) {
      next[side] = Math.max(0, Math.min(100, before[side] + Number(deltas?.[side] || 0)));
    }
    if (absolute) next = applyZGaugeCause(before, { cause, deltas, absolute }).gauges;
    // Native legal near-cap witnesses retain every accepted cause even when
    // both actual deltas clamp to zero: KO, final battle, then next-turn event.
    // Explicit caller-supplied no-op deltas retain their previous no-op behavior.
    const acceptedRuleCause = ["base_battle_knockout", "rock_slide_knockout", "battle_surround_knockout", "touch_surround_knockout", "condition_recovery_surround_knockout", "resolved_battle_and_final_miss", "resolved_z_battle_and_final_miss", "turn_started"].includes(cause);
    if (!acceptedRuleCause && next.black === before.black && next.white === before.white) return null;
    const move = {
      display_info: "move",
      selective_side: "neither",
      value: {
        type: "add_z_gauge",
        black: Number(next.black) - before.black,
        black_result: Number(next.black),
        white: Number(next.white) - before.white,
        white_result: Number(next.white),
      },
    };
    if (!this.appendMove(match, move)) return null;
    match.zGauge = next;
    this.sendSequenced(match, `do_move ${JSON.stringify(move)}`);
    logMatchEvent(match, "add_z_gauge", { ...move.value, award_cause: cause });
    return move;
  }
}

export const customMatchContract = Object.freeze({
  localUserId: LOCAL_USER_ID,
  opponentUserId: OPPONENT_USER_ID,
  deck: DECK,
  decks: DECKS,
  plateIds: PLATE_IDS,
  matchPlateIds: MATCH_PLATE_IDS,
  fieldEdges: FIELD_EDGES,
  evidenceRecordSha256: "88D36BC23825A7A3BF13688AAA9C5C83D1969AFBC7D5036C44F2DFEBFA6CA62E",
});

export const customMatchTestHooks = Object.freeze({
  legalBenchEntryMoves, validateBenchEntryMove,
  applyPositionMove,
  baseSkillWinner,
  // Historical synthetic cleanup fixture only, not production ordinal proof.
  completeTurn: completeTurnCleanup,
  legalRoutes,
  makeRecord,
  ensurePlateState,
  plateStateSnapshot,
  ensureZState,
  zChoices,
  zBattleCapability,
  zStateSnapshot,
  paralysisDisabledSkill,
  conditionDisabledSkills,
  conditionSpinDisplacement,
  applyConditionBattleDamage,
  smallestAttackIds,
  selectedSkill,
  selectedSpinSkill,
  rollBattleWheel,
  validateMovement,
  validateBattleDeclaration,
  pendingBattlesAfterMovement,
  pendingMpBattleMandatory,
  validatePlateMove,
  wheelRange,
});

// Shared record construction and rule primitives. Human matchmaking supplies
// independent account/connection authority without forking the recovered rules.
export const customMatchPrimitives = Object.freeze({
  applySelectedDeck,
  makePlayGame,
  normalizeMove,
  moveType,
  playerSummary,
  recordDeck,
});
