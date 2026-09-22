// UNINTEGRATED infrastructure. No legality, timers, gauges, positions, IO or clock.
// The controller must validate semantic finality against its pending transaction.
// Hashes below bind bytes/identity; they are not evidence that a rule really ended.
import {canonicalToken,canonicalDigest,ENCODING} from './timed-exclusion-state.mjs';

export const LEDGER_SCHEMA='kiwi-completed-turn-ledger-1';
export const FACT_SCHEMA='kiwi-semantic-turn-completion-1';
export const CAUSE_SCHEMA='kiwi-completed-turn-ordinal-cause-1';
export const CHECKPOINT_SCHEMA='kiwi-completed-turn-checkpoint-1';
export const MAX_COMPLETIONS=1024, MAX_RECORD_MOVES=10000;
export const COMPLETION_KINDS=Object.freeze(['nonbattle_mp_move','nonbattle_spot_move','resolved_battle','null_move','declare_turn_end','turn_ending_plate','touch','declaration_surround']);
const copy=v=>structuredClone(v), hash=v=>canonicalDigest(v);
const requireValue=(ok,reason)=>{if(!ok)throw new TypeError(reason);};
const integer=(v,lo,hi)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi;
const side=v=>v==='black'||v==='white';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const attempt=fn=>{try{return fn();}catch(e){return {ok:false,reason:e.message};}};
const same=(a,b)=>canonicalToken(a)===canonicalToken(b);
const FACT_KEYS=['schema','ordinal','kind','ended_side','action_record_index','record_move_count','finalized','pending_choice','pending_callbacks'];
const CAUSE_KEYS=['schema','encoding','match_id','definition_sha256','ordinal','kind','ended_side','action_record_index','record_move_count',
  'record_sha256','action_sha256','finalized','pending_choice','pending_callbacks'];
const STATE_KEYS=['schema','encoding','match_id','definition_sha256','completed_turns','completions'];
function recordInfo(record){
  canonicalToken(record);
  requireValue(record&&typeof record==='object'&&!Array.isArray(record)&&typeof record.id==='string'
    &&record.id.length>0&&record.id.length<=128&&Array.isArray(record.all_moves)&&record.all_moves.length<=MAX_RECORD_MOVES,'record_shape');
  requireValue(Array.isArray(record.players)&&record.players.length===2&&record.players[0]?.color==='black'
    &&record.players[1]?.color==='white','record_players');
  const definitions=copy(record);delete definitions.all_moves;
  return {match_id:record.id,definition_sha256:hash(definitions)};
}
function prefix(record,count){const next=copy(record);next.all_moves=next.all_moves.slice(0,count);return next;}
function prefixHasher(record){const cache=new Map();return count=>{
  if(!cache.has(count))cache.set(count,hash(prefix(record,count)));return cache.get(count);
};}
function checkedFacts(facts,record){
  canonicalToken(facts);
  requireValue(exact(facts,FACT_KEYS)&&facts.schema===FACT_SCHEMA&&integer(facts.ordinal,1,MAX_COMPLETIONS)
    &&COMPLETION_KINDS.includes(facts.kind)&&side(facts.ended_side)
    &&integer(facts.record_move_count,1,record.all_moves.length)
    &&integer(facts.action_record_index,0,facts.record_move_count-1),'completion_facts_shape');
  requireValue(facts.finalized===true&&facts.pending_choice===false&&facts.pending_callbacks===0,'caller_completion_not_final');
  const anchor=record.all_moves[facts.action_record_index],value=anchor?.value;
  requireValue(anchor&&typeof anchor==='object'&&!Array.isArray(anchor)&&value&&typeof value==='object'&&!Array.isArray(value),'completion_anchor_shape');
  if(facts.kind==='resolved_battle')requireValue(anchor.selective_side==='both'&&value.type==='spin','completion_not_spin');
  else{
    requireValue(anchor.selective_side===facts.ended_side,'completion_anchor_side');
    if(facts.kind==='nonbattle_mp_move')requireValue(value.type==='mp_move','completion_not_mp');
    else if(facts.kind==='declaration_surround')requireValue(exact(value,['type','from_pokemon','to_pokemon'])&&value.type==='declare_battle'
      &&integer(value.from_pokemon,0,11)&&integer(value.to_pokemon,0,11)&&value.from_pokemon!==value.to_pokemon,'completion_not_battle_declaration');
    else if(facts.kind==='nonbattle_spot_move')requireValue(value.type==='spot_move','completion_not_spot');
    else if(facts.kind==='turn_ending_plate')requireValue(value.type==='declare_plate'&&(['spot_move','swap_move'].includes(value.value?.type)
      || [5377,5378,5379,5380,5386,5404,5412,5416,5445].includes(value.plate_id)&&value.value?.type==='select_pokemon_and_declare_aura'),'completion_not_turn_ending_plate');
    else requireValue(value.type===facts.kind,'completion_not_end_or_null');
  }
  // Anchor shape only. Route legality, actor identity, wheel/result validity,
  // plate rules and whether another callback remains are controller obligations.
  return facts;
}
function causeFromFacts(record,info,facts,prefixHash){
  checkedFacts(facts,record);
  return {schema:CAUSE_SCHEMA,encoding:ENCODING,...info,ordinal:facts.ordinal,kind:facts.kind,ended_side:facts.ended_side,
    action_record_index:facts.action_record_index,record_move_count:facts.record_move_count,
    record_sha256:prefixHash(facts.record_move_count),action_sha256:hash(record.all_moves[facts.action_record_index]),
    finalized:true,pending_choice:false,pending_callbacks:0};
}
function checkedCause(cause,record,info,prefixHash){
  canonicalToken(cause);requireValue(exact(cause,CAUSE_KEYS)&&cause.schema===CAUSE_SCHEMA&&cause.encoding===ENCODING,'cause_shape');
  const facts={schema:FACT_SCHEMA};for(const key of FACT_KEYS)if(key!=='schema')facts[key]=cause[key];
  requireValue(same(cause,causeFromFacts(record,info,facts,prefixHash)),'cause_identity_or_prefix');
}
function checkedState(state,record){
  canonicalToken(state);const info=recordInfo(record),prefixHash=prefixHasher(record);
  requireValue(exact(state,STATE_KEYS)&&state.schema===LEDGER_SCHEMA&&state.encoding===ENCODING
    &&state.match_id===info.match_id&&state.definition_sha256===info.definition_sha256
    &&integer(state.completed_turns,0,MAX_COMPLETIONS)&&Array.isArray(state.completions)
    &&state.completions.length===state.completed_turns,'ledger_identity_or_count');
  let previousCount=0;
  for(let i=0;i<state.completions.length;i++){
    const cause=state.completions[i];checkedCause(cause,record,info,prefixHash);
    requireValue(cause.ordinal===i+1&&cause.record_move_count>previousCount&&cause.action_record_index>=previousCount,'ledger_ordinal_or_causal_order');
    previousCount=cause.record_move_count;
  }
  return {info,prefixHash};
}
export function createLedger(record){return attempt(()=>{
  const info=recordInfo(record);requireValue(record.all_moves.length===0,'genesis_requires_empty_record');
  return {ok:true,reason:'',changed:true,state:{schema:LEDGER_SCHEMA,encoding:ENCODING,...info,completed_turns:0,completions:[]},effects:[]};
});}
// Explicit checkpoint/replay boundary, not a per-frame projection hook. The
// caller must supply the complete, semantically validated completion journal.
// An empty journal does NOT certify that a nonempty record has no completions.
// No external cache/checkpoint is trusted: derive empty genesis from these exact
// definitions, build all causes privately, then validate the whole state once.
// This avoids repeatedly validating every earlier prefix after every appended
// cause. Distinct prefix hashing is still O(completions * record size), not a
// constant-time operation or an independently proven gameplay-finality test.
export function replayCompletions(record,facts){return attempt(()=>{
  const info=recordInfo(record);
  canonicalToken(facts);
  requireValue(Array.isArray(facts)&&facts.length<=MAX_COMPLETIONS,'completion_journal_shape');
  const genesis=copy(record);genesis.all_moves=[];
  const initial=createLedger(genesis);requireValue(initial.ok,initial.reason);
  const state=initial.state,prefixHash=prefixHasher(record);
  for(const fact of facts)state.completions.push(causeFromFacts(record,info,fact,prefixHash));
  state.completed_turns=facts.length;
  checkedState(state,record);
  return {ok:true,reason:'',changed:true,state,effects:[]};
});}
// This does not certify the supplied finality facts. Call only from a validated
// semantic completion seam, never directly on receipt of an arbitrary record.
export function proposeCompletion(record,facts){return attempt(()=>{
  const info=recordInfo(record),cause=causeFromFacts(record,info,facts,prefixHasher(record));
  return {ok:true,reason:'',cause};
});}
export function commitCompletion(state,cause,record){return attempt(()=>{
  const {info,prefixHash}=checkedState(state,record);checkedCause(cause,record,info,prefixHash);
  if(cause.ordinal<=state.completed_turns){
    requireValue(same(cause,state.completions[cause.ordinal-1]),'stale_or_conflicting_completion');
    return {ok:true,reason:'',changed:false,state:copy(state),completion:copy(cause),effects:[]};
  }
  requireValue(cause.ordinal===state.completed_turns+1,'skipped_completion_ordinal');
  const prior=state.completions.at(-1);
  requireValue(!prior||(cause.record_move_count>prior.record_move_count&&cause.action_record_index>=prior.record_move_count),'stale_or_reused_completion_anchor');
  const next=copy(state);next.completed_turns++;next.completions.push(copy(cause));
  checkedState(next,record);
  return {ok:true,reason:'',changed:true,state:next,completion:copy(cause),effects:[]};
});}
// Inspect pending/gauge/PC records without treating their presence as a tick.
export function inspectLedger(state,record){return attempt(()=>{
  checkedState(state,record);
  return {ok:true,reason:'',changed:false,state:copy(state),effects:[],record_move_count:record.all_moves.length,
    last_completion:copy(state.completions.at(-1)??null),runtime_integrated:false};
});}
export function snapshotLedger(state,record){return attempt(()=>{
  const {info,prefixHash}=checkedState(state,record);
  const checkpoint={schema:CHECKPOINT_SCHEMA,encoding:ENCODING,
    record_binding:{...info,record_move_count:record.all_moves.length,record_sha256:prefixHash(record.all_moves.length)},state:copy(state)};
  canonicalToken(checkpoint);return {ok:true,reason:'',checkpoint};
});}
export function restoreLedger(checkpoint,record,currentState=null){return attempt(()=>{
  canonicalToken(checkpoint);const info=recordInfo(record);
  requireValue(exact(checkpoint,['schema','encoding','record_binding','state'])&&checkpoint.schema===CHECKPOINT_SCHEMA
    &&checkpoint.encoding===ENCODING,'checkpoint_shape');
  const binding=checkpoint.record_binding;
  requireValue(exact(binding,['match_id','definition_sha256','record_move_count','record_sha256'])
    &&binding.match_id===info.match_id&&binding.definition_sha256===info.definition_sha256
    &&integer(binding.record_move_count,0,record.all_moves.length),'checkpoint_binding');
  const boundRecord=prefix(record,binding.record_move_count);
  requireValue(binding.record_sha256===hash(boundRecord),'checkpoint_prefix_changed');
  checkedState(checkpoint.state,boundRecord);
  let changed=true;
  if(currentState!==null){
    checkedState(currentState,record);
    requireValue(checkpoint.state.completed_turns>=currentState.completed_turns,'checkpoint_ordinal_rollback');
    requireValue(same(checkpoint.state.completions.slice(0,currentState.completed_turns),currentState.completions),'checkpoint_conflicting_history');
    changed=!same(checkpoint.state,currentState);
  }
  return {ok:true,reason:'',state:copy(checkpoint.state),changed,effects:[],verified_prefix_count:binding.record_move_count,
    unreplayed_record_count:record.all_moves.length-binding.record_move_count,runtime_integrated:false};
});}
