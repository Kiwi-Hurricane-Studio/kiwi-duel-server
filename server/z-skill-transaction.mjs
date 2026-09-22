// Pure, native-proven transaction mechanics, not a Z move legality/catalog.
// The caller must generate validated legal actions AND have a supported skill
// handler before selecting. No fixture, player identity, disk or socket access.
import { completedBattleGaugeAwards } from './z-gauge-rules.mjs';

const SIDES = ['black', 'white'];
const PHASES = ['selected', 'battle_choice', 'resolving'];
function requireValue(condition, error) { if (!condition) throw new TypeError(error); }
function sideOf(pokemon) { return pokemon < 6 ? 'black' : 'white'; }
function isPokemon(value) { return Number.isInteger(value) && value >= 0 && value < 12; }
function choice(action) {
  requireValue(action && typeof action === 'object' && !Array.isArray(action), 'invalid_z_choice');
  const value = action.value;
  requireValue(SIDES.includes(action.selective_side) && value?.type === 'z_skill', 'invalid_z_choice');
  requireValue(isPokemon(value.pokemon) && sideOf(value.pokemon) === action.selective_side, 'invalid_z_actor');
  requireValue(Number.isSafeInteger(value.dst_skill_id) && value.dst_skill_id > 0, 'invalid_z_destination');
  requireValue(Number.isSafeInteger(value.speed_or_damage) && value.speed_or_damage >= 0, 'invalid_z_power');
  requireValue(Object.keys(value).sort().join(',') === 'dst_skill_id,pokemon,speed_or_damage,type', 'unexpected_z_choice_fields');
  return { side:action.selective_side, pokemon:value.pokemon, dst_skill_id:value.dst_skill_id, speed_or_damage:value.speed_or_damage };
}
function checkedState(state) {
  requireValue(state?.schema === 1 && Object.keys(state).sort().join(',') === 'active,schema', 'invalid_z_transaction_schema');
  if (state.active === null) return state;
  const active = state.active;
  requireValue(active && typeof active === 'object' && !Array.isArray(active), 'invalid_z_transaction_active');
  requireValue(Object.keys(active).sort().join(',') === 'battle,dst_skill_id,phase,pokemon,selected_record_index,side,speed_or_damage', 'invalid_z_transaction_fields');
  choice({selective_side:active.side,value:{type:'z_skill',pokemon:active.pokemon,dst_skill_id:active.dst_skill_id,speed_or_damage:active.speed_or_damage}});
  requireValue(Number.isSafeInteger(active.selected_record_index) && active.selected_record_index >= 0, 'invalid_z_record_index');
  requireValue(PHASES.includes(active.phase), 'invalid_z_phase');
  if (active.phase === 'resolving') {
    requireValue(active.battle && Object.keys(active.battle).sort().join(',') === 'attacker,defender'
      && active.battle.attacker === active.pokemon && isPokemon(active.battle.defender)
      && sideOf(active.battle.defender) !== active.side, 'invalid_z_battle_binding');
  } else requireValue(active.battle === null, 'unexpected_z_battle_binding');
  return state;
}

export function createZTransactionState() { return {schema:1,active:null}; }

export function selectZTransaction(state, {action, legalActions, recordIndex}) {
  checkedState(state);
  requireValue(state.active === null, 'z_selection_already_active');
  requireValue(Number.isSafeInteger(recordIndex) && recordIndex >= 0, 'invalid_z_record_index');
  const selected = choice(action);
  requireValue(Array.isArray(legalActions) && legalActions.some(candidate => {
    if (candidate?.value?.type !== 'z_skill') return false;
    const canonical = choice(candidate);
    return Object.keys(selected).every(key=>selected[key]===canonical[key]);
  }), 'z_choice_not_advertised');
  // Selection marks the actor but does not consume gauge, change the wheel
  // record, invent an effect or end the turn. Those are separate engine facts.
  return {schema:1,active:{...selected,selected_record_index:recordIndex,phase:'selected',battle:null}};
}

export function advanceZTransaction(state, event) {
  checkedState(state);
  const active = state.active;
  requireValue(active !== null, 'z_selection_missing');
  requireValue(event?.pokemon === active.pokemon, 'wrong_z_continuation_actor');
  const next = structuredClone(state);
  if (event.kind === 'move_into_battle_choice') {
    requireValue(active.phase === 'selected', 'invalid_z_move_phase');
    next.active.phase = 'battle_choice';
  } else if (event.kind === 'declare_battle') {
    requireValue(['selected','battle_choice'].includes(active.phase), 'invalid_z_battle_phase');
    requireValue(isPokemon(event.defender) && sideOf(event.defender) !== active.side, 'invalid_z_battle_target');
    next.active.phase = 'resolving';
    next.active.battle = {attacker:active.pokemon,defender:event.defender};
  } else throw new TypeError('unsupported_z_transition');
  return next;
}

export function filterZPlayerContinuations(state, validatedActions, positions) {
  checkedState(state);
  requireValue(Array.isArray(validatedActions), 'invalid_z_continuations');
  if (state.active === null) return structuredClone(validatedActions);
  const {side,pokemon,phase} = state.active;
  if (phase === 'resolving') return [];
  const point = positions instanceof Map ? positions.get(pokemon) : positions?.[pokemon];
  requireValue(Number.isInteger(point) && point >= 0, 'missing_z_actor_position');
  return validatedActions.filter(action=>{
    if(action?.selective_side !== side) return false;
    const value=action.value;
    if(value?.type === 'declare_battle') return value.from_pokemon === pokemon;
    if(phase === 'battle_choice') return value?.type === 'null_move';
    return value?.type === 'mp_move' && Array.isArray(value.route) && value.route[0] === point;
  }).map(action=>structuredClone(action));
}

export function finishZNonbattleTurn(state, side) {
  checkedState(state);
  requireValue(state.active?.side === side && state.active.phase !== 'resolving', 'invalid_z_nonbattle_finish');
  // Called only after the rules engine actually completes a nonbattle turn,
  // not as player authorization for an otherwise unavailable end-turn action.
  return {state:createZTransactionState(),gaugeCauses:[]};
}

export function finishZBattle(state, facts) {
  checkedState(state);
  const active=state.active;
  requireValue(active?.phase === 'resolving', 'invalid_z_final_battle_phase');
  requireValue(facts?.attackingSide === active.side && facts.attacker === active.battle.attacker
    && facts.defender === active.battle.defender, 'z_battle_result_binding_mismatch');
  requireValue(typeof facts.finalized === 'boolean', 'z_finalization_fact_required');
  // A provisional result cannot call the final award/expiration path. This is
  // a transaction guard, not a claim of native Z+DoubleChance joint coverage.
  if (!facts.finalized) return {state:structuredClone(state),gaugeCauses:[]};
  requireValue(['win','draw','lose'].includes(facts.zBattleOutcome), 'z_battle_outcome_fact_required');
  requireValue(facts.zBattleOutcome === 'win' || active.dst_skill_id === 1717
    || (active.dst_skill_id === 1715 && facts.zBattleOutcome === 'lose' && facts.defenderColor === 3),
    'z_unsuccessful_destination_not_proven');
  const causes=completedBattleGaugeAwards(facts);
  const final=causes.at(-1);
  final.cause='resolved_z_battle_and_final_miss';
  // Absolute reset takes precedence over this side's ordinary attacker/Miss
  // credit in the final battle event, not over earlier KO or next-turn causes.
  // Native1717 Gold loss/equal-Purple tie and the hash-bound four-window1715
  // Gold control retain50. Successful effects consume100.1715 ties, Blue and
  // non-Gold losses still have no accepted native witness and remain gated.
  final.absolute={ [active.side]:facts.zBattleOutcome === 'win' ? 0 : 50 };
  return {state:createZTransactionState(),gaugeCauses:causes};
}

export function applyZGaugeCause(gauges, cause) {
  requireValue(gauges && SIDES.every(side=>Number.isInteger(gauges[side])&&gauges[side]>=0&&gauges[side]<=100), 'invalid_z_current_gauges');
  requireValue(cause && typeof cause.cause === 'string' && cause.cause.length>0
    && cause.deltas && Object.keys(cause.deltas).every(side=>SIDES.includes(side))
    && SIDES.every(side=>Number.isSafeInteger(cause.deltas[side])), 'invalid_z_gauge_cause');
  const absolute=cause.absolute ?? {};
  requireValue(absolute && typeof absolute==='object' && !Array.isArray(absolute)
    && Object.keys(absolute).every(side=>SIDES.includes(side)&&Number.isInteger(absolute[side])&&absolute[side]>=0&&absolute[side]<=100), 'invalid_z_absolute_override');
  const result={};
  for(const side of SIDES) result[side]=Object.hasOwn(absolute,side)?absolute[side]:Math.max(0,Math.min(100,gauges[side]+cause.deltas[side]));
  return {gauges:result,value:{type:'add_z_gauge',black:result.black-gauges.black,black_result:result.black,
    white:result.white-gauges.white,white_result:result.white}};
}

export function copyZTransactionState(state) { return structuredClone(checkedState(state)); }
