// UNINTEGRATED domain preparation. No battle eligibility, gauge, KO, network or IO.
// Supplied neutral facts are caller assertions, not independently derived rules.
import {createHash} from 'node:crypto';
export const SCHEMA = 'kiwi-timed-exclusion-state-1';
export const CAUSE_SCHEMA = 'kiwi-completed-turn-cause-1';
export const ENCODING = 'kiwi-integral-json-utf8-1';
const MAX = 9007199254740991;
const requireValue = (v, reason) => { if (!v) throw new TypeError(reason); };
const integer = (v, lo = 0, hi = MAX) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const side = p => p < 6 ? 'black' : 'white';
const copy = v => structuredClone(v);
const exact = (v, keys) => v && !Array.isArray(v) && typeof v === 'object'
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const hash = s => createHash('sha256').update(s, 'utf8').digest('hex');
const validHash = h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
const attempt = action => { try { return action(); } catch (e) { return {ok:false, reason:e.message}; } };

// This is NOT JSON.stringify or a replacement for historical raw-byte hashes.
// n; b0/b1; i<decimal>; s<UTF8 byte length>:<literal>; a<count>[...];
// o<count>{<key token><value token>...}. Object keys sorted by Unicode scalar.
// All numeric values are finite integral, ±(2^53−1); −0 normalizes to 0.
export function canonicalToken(value) {
  let nodes = 0;
  function token(v, depth) {
    requireValue(++nodes <= 100000 && depth <= 24, 'json_complexity');
    if (v === null) return 'n';
    if (typeof v === 'boolean') return v ? 'b1' : 'b0';
    if (typeof v === 'number') { requireValue(integer(v, -MAX), 'json_number'); return `i${v};`; }
    if (typeof v === 'string') {
      requireValue(v.length <= 32768 && v.isWellFormed(), 'json_string');
      return `s${Buffer.byteLength(v, 'utf8')}:${v}`;
    }
    requireValue(v && typeof v === 'object' && [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v)), 'json_type');
    requireValue(Reflect.ownKeys(v).every(k => typeof k === 'string'), 'json_keys');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    requireValue(Object.entries(descriptors).every(([k,d]) => (Array.isArray(v) && k === 'length') || (d.enumerable && Object.hasOwn(d,'value'))), 'json_descriptor');
    if (Array.isArray(v)) {
      requireValue(v.length <= 10000 && Object.keys(v).length === v.length && Object.keys(v).every((k,i)=>k === String(i)), 'json_array');
      return `a${v.length}[${v.map(x=>token(x,depth+1)).join('')}]`;
    }
    const keys = Object.keys(v).sort(unicodeOrder);
    requireValue(keys.length <= 256, 'json_keys');
    return `o${keys.length}{${keys.map(k=>token(k,depth+1)+token(v[k],depth+1)).join('')}}`;
  }
  const result = token(value,0);
  requireValue(Buffer.byteLength(result,'utf8') <= 1048576, 'json_bytes');
  return result;
}
function unicodeOrder(a,b) {
  const x=[...a], y=[...b];
  for(let i=0;i<Math.min(x.length,y.length);i++) if(x[i]!==y[i]) return x[i].codePointAt(0)-y[i].codePointAt(0);
  return x.length-y.length;
}
export const canonicalDigest = value => hash(`${ENCODING}\n${canonicalToken(value)}`);
function recordInfo(record) {
  canonicalToken(record);
  requireValue(record && !Array.isArray(record) && typeof record === 'object', 'record_shape');
  requireValue(typeof record.id === 'string' && /^[1-9][0-9]{0,15}$/.test(record.id) && BigInt(record.id)<=BigInt(MAX), 'record_id');
  requireValue(Array.isArray(record.all_moves) && record.all_moves.length <= 10000 && Array.isArray(record.players) && record.players.length === 2, 'record_shape');
  for (let s=0;s<2;s++) {
    const p=record.players[s];
    requireValue(exact(p,['color','id','plates','pokemons']) && p.color === ['black','white'][s] && Array.isArray(p.pokemons) && p.pokemons.length===6, 'record_players');
    for(let i=0;i<6;i++) requireValue(p.pokemons[i] && integer(p.pokemons[i].id,1) && p.pokemons[i].pokemon_index===s*6+i, 'record_actor_ids');
  }
  const definitions=copy(record); delete definitions.all_moves;
  return {match_id:record.id, definition_sha256:canonicalDigest(definitions)};
}
function causeFor(record, kind, endedSide) {
  const info=recordInfo(record), count=record.all_moves.length;
  requireValue(count>0 && ['resolved_battle','nonbattle_mp_move'].includes(kind) && ['black','white'].includes(endedSide), 'boundary_kind');
  const last=record.all_moves.at(-1);
  requireValue(last && exact(last,['selective_side','value']) && last.value && typeof last.value==='object', 'boundary_move');
  if(kind==='resolved_battle') requireValue(last.selective_side==='both' && last.value.type==='spin', 'boundary_not_resolved_spin');
  else requireValue(last.selective_side===endedSide && exact(last.value,['type','route']) && last.value.type==='mp_move'
    && Array.isArray(last.value.route) && last.value.route.length>=2 && last.value.route.length<=28
    && last.value.route.every(p=>integer(p,0,39)), 'boundary_not_mp');
  return {schema:CAUSE_SCHEMA, ...info, record_index:count-1, record_move_count:count,
    record_sha256:canonicalDigest(record), kind, ended_side:endedSide};
}
const CAUSE_KEYS=['schema','match_id','definition_sha256','record_index','record_move_count','record_sha256','kind','ended_side'];
function checkedCause(c,record,info) {
  requireValue(exact(c,CAUSE_KEYS) && c.schema===CAUSE_SCHEMA && c.match_id===info.match_id && c.definition_sha256===info.definition_sha256
    && integer(c.record_index,0,9999) && integer(c.record_move_count,1,10000) && c.record_move_count===c.record_index+1 && c.record_move_count<=record.all_moves.length
    && validHash(c.record_sha256), 'cause_shape');
  const prefix=copy(record); prefix.all_moves=prefix.all_moves.slice(0,c.record_move_count);
  requireValue(canonicalToken(causeFor(prefix,c.kind,c.ended_side))===canonicalToken(c), 'cause_prefix');
}
function checkedCreationPair(record,pokemon,actor,count) {
  const declaration=record.all_moves[count-2], spins=record.all_moves[count-1]?.value;
  requireValue(exact(declaration,['selective_side','value']) && declaration.selective_side===side(actor)
    && exact(declaration.value,['type','from_pokemon','to_pokemon']) && declaration.value.type==='declare_battle'
    && declaration.value.from_pokemon===actor && declaration.value.to_pokemon===pokemon
    && exact(spins,['type','spins']) && spins.type==='spin' && Array.isArray(spins.spins) && spins.spins.length===2
    && [actor,pokemon].every(p=>spins.spins.filter(s=>s?.pokemon===p).length===1), 'removal_battle_binding');
}
function checked(state,positions,record) {
  canonicalToken(state); canonicalToken(positions);
  const info=recordInfo(record);
  requireValue(exact(state,['schema','match_id','definition_sha256','last_boundary','timed','untimed']) && state.schema===SCHEMA
    && state.match_id===info.match_id && state.definition_sha256===info.definition_sha256, 'state_identity');
  requireValue(Array.isArray(positions) && positions.length===12, 'positions_shape');
  const occupied=new Set();
  for(let i=0;i<12;i++) {
    const p=positions[i];
    requireValue(integer(p,0,55) && (p<28 || p===28+i || p===44+i), 'personal_slot_or_pc_unsupported');
    requireValue(!occupied.has(p), 'position_overlap'); occupied.add(p);
  }
  requireValue(Array.isArray(state.untimed) && state.untimed.length<=12 && state.untimed.every((p,i)=>integer(p,0,11) && (i===0 || p>state.untimed[i-1])), 'untimed_shape');
  if(state.last_boundary!==null) checkedCause(state.last_boundary,record,info);
  const t=state.timed;
  if(t!==null) {
    requireValue(exact(t,['pokemon','actor','skill_id','origin_point','point','remaining','cause']) && integer(t.pokemon,0,11)
      && integer(t.actor,0,11) && side(t.pokemon)!==side(t.actor) && t.skill_id===1692 && integer(t.origin_point,0,27)
      && t.point===44+t.pokemon && integer(t.remaining,1,7) && !state.untimed.includes(t.pokemon), 'timed_shape');
    checkedCause(t.cause,record,info);
    requireValue(t.cause.kind==='resolved_battle' && t.cause.ended_side===side(t.actor), 'timed_creation');
    checkedCreationPair(record,t.pokemon,t.actor,t.cause.record_move_count);
    if(t.remaining===7) requireValue(state.last_boundary===null || state.last_boundary.record_index<t.cause.record_index,'timed_phase');
    else requireValue(state.last_boundary!==null && state.last_boundary.record_index>=t.cause.record_index
      && t.remaining===6-(state.last_boundary.record_index-t.cause.record_index), 'timed_phase');
  }
  for(let p=0;p<12;p++) requireValue((positions[p]===44+p)===(state.untimed.includes(p) || t?.pokemon===p), 'excluded_disposition');
  return info;
}
export function createState(record,positions,untimed=[]) {
  return attempt(()=>{
    canonicalToken(untimed); const info=recordInfo(record);
    const state={schema:SCHEMA,...info,last_boundary:null,timed:null,untimed:copy(untimed)};
    checked(state,positions,record); return {ok:true,reason:'',state,positions:copy(positions),effects:[],changed:true};
  });
}
export function begin1692Removal(state,input,positions,record) {
  return attempt(()=>{
    checked(state,positions,record); canonicalToken(input);
    requireValue(exact(input,['pokemon','actor','skill_id','duration','victim_condition','victim_wait','actor_condition','actor_wait'])
      && integer(input.pokemon,0,11) && integer(input.actor,0,11) && side(input.pokemon)!==side(input.actor)
      && input.skill_id===1692 && input.duration===7 && input.victim_condition==='normal' && input.victim_wait===0
      && input.actor_condition==='normal' && input.actor_wait===0, 'removal_facts');
    requireValue(state.timed===null,'multiple_timed_unproven');
    const cause=causeFor(record,'resolved_battle',side(input.actor));
    checkedCreationPair(record,input.pokemon,input.actor,cause.record_move_count);
    requireValue(state.last_boundary===null || cause.record_index>state.last_boundary.record_index,'stale_creation');
    requireValue(state.last_boundary===null || cause.ended_side!==state.last_boundary.ended_side,'creation_extra_turn_unproven');
    requireValue(positions[input.pokemon]<28 && positions[input.actor]<28,'actor_not_on_field');
    const next=copy(state), nextPositions=copy(positions);
    next.timed={pokemon:input.pokemon,actor:input.actor,skill_id:1692,origin_point:positions[input.pokemon],point:44+input.pokemon,remaining:7,cause};
    nextPositions[input.pokemon]=44+input.pokemon;
    checked(next,nextPositions,record);
    return {ok:true,reason:'',state:next,positions:nextPositions,effects:[{selective_side:'neither',value:{duration:7,pokemons:[input.pokemon],type:'remove_pokemon_with_duration'}}],changed:true};
  });
}
export function advanceCompletedTurn(state,boundary,positions,record) {
  return attempt(()=>{
    checked(state,positions,record); canonicalToken(boundary);
    requireValue(exact(boundary,['kind','ended_side']),'boundary_fields');
    const cause=causeFor(record,boundary.kind,boundary.ended_side), prior=state.last_boundary;
    if(prior && cause.record_index<=prior.record_index) {
      requireValue(canonicalToken(cause)===canonicalToken(prior),'stale_or_conflicting_boundary');
      return {ok:true,reason:'',state:copy(state),positions:copy(positions),effects:[],changed:false};
    }
    const t=state.timed;
    if(prior && t?.remaining!==7) requireValue(cause.record_index===prior.record_index+1 && cause.kind==='nonbattle_mp_move'
      && cause.ended_side!==prior.ended_side,'continuation_boundary_unproven');
    if(t?.remaining===7) requireValue(canonicalToken(cause)===canonicalToken(t.cause),'creation_boundary_skipped');
    else if(t) requireValue(cause.kind==='nonbattle_mp_move','continuation_boundary_unproven');
    const next=copy(state), nextPositions=copy(positions), effects=[];
    if(t) {
      if(t.remaining>1) next.timed.remaining--;
      else { nextPositions[t.pokemon]=28+t.pokemon; next.timed=null; effects.push({selective_side:'neither',value:{pokemon:t.pokemon,type:'bench_move'}}); }
    }
    next.last_boundary=cause; checked(next,nextPositions,record);
    return {ok:true,reason:'',state:next,positions:nextPositions,effects,changed:true};
  });
}
export function snapshot(state,positions,record) {
  return attempt(()=>{
    checked(state,positions,record);
    return {ok:true,reason:'',schema:SCHEMA,figures:positions.map((point,pokemon)=>({pokemon,point,
      excluded:point===44+pokemon,disposition:state.timed?.pokemon===pokemon?'timed':state.untimed.includes(pokemon)?'untimed':'present',
      remove_duration:state.timed?.pokemon===pokemon?state.timed.remaining:-1})),state:copy(state),runtime_integrated:false};
  });
}
