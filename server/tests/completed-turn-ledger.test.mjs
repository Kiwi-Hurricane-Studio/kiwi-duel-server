import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as Ledger from '../completed-turn-ledger.mjs';
import {canonicalToken,canonicalDigest,ENCODING} from '../timed-exclusion-state.mjs';
const copy=v=>structuredClone(v),must=r=>{assert.equal(r.ok,true,r.reason);return r;};
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function base(){return {id:'synthetic-turn-ledger',players:[{color:'black',id:'black-fixture',pokemons:[]},{color:'white',id:'white-fixture',pokemons:[]}],
  seed:563,version:1,all_moves:[]};}
const move=(side,type,extra={})=>({display_info:'move',selective_side:side,value:{type,...extra}});
const mp=side=>move(side,'mp_move',{route:[0,1]});
const gauge=()=>move('neither','add_z_gauge',{black:0,white:0,black_result:100,white_result:100});
const declaration=()=>move('white','declare_battle',{from_pokemon:7,to_pokemon:0});
const spin=()=>move('both','spin',{spins:[{pokemon:7,value:1},{pokemon:0,value:2}]});
function facts(record,kind='nonbattle_mp_move',side='black',ordinal=1,index=record.all_moves.length-1,count=record.all_moves.length){
  return {schema:Ledger.FACT_SCHEMA,ordinal,kind,ended_side:side,action_record_index:index,record_move_count:count,
    finalized:true,pending_choice:false,pending_callbacks:0};
}
function first(){const record=base(),initial=must(Ledger.createLedger(record)).state;record.all_moves.push(mp('black'));
  const cause=must(Ledger.proposeCompletion(record,facts(record))).cause,state=must(Ledger.commitCompletion(initial,cause,record)).state;
  return {record,initial,cause,state};}
function second(){const f=first();f.record.all_moves.push(gauge(),declaration(),spin(),gauge(),move('neither','knockedout_move',{pokemon:0,index:40}),gauge());
  const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'resolved_battle','white',2,3))).cause;
  return {...f,firstState:copy(f.state),firstCause:copy(f.cause),cause,state:must(Ledger.commitCompletion(f.state,cause,f.record)).state};}
test('genesis is pure empty-record infrastructure with no effects',()=>{
  const r=base(),before=copy(r),s=must(Ledger.createLedger(r));assert.equal(s.state.completed_turns,0);assert.deepEqual(s.effects,[]);assert.deepEqual(r,before);
  assert.equal(s.state.encoding,ENCODING);assert.equal(s.state.definition_sha256,canonicalDigest(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='all_moves'))));
});
test('refuses undocumented initial ordinal for nonempty historical record',()=>{const r=base();r.all_moves.push(mp('black'));assert.equal(Ledger.createLedger(r).ok,false);});
test('same canonical encoding and all13 shared vectors, including Unicode/integral',()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(project,'tests/fixtures/timed_exclusion_v1.json')));
  assert.equal(fixture.canonical_vectors.length,13);for(const v of fixture.canonical_vectors){assert.equal(canonicalToken(v.value),v.token);assert.equal(canonicalDigest(v.value),v.sha256);}
  const a=base(),b={all_moves:[],version:a.version,seed:a.seed,players:copy(a.players),id:a.id};
  assert.deepEqual(must(Ledger.createLedger(a)).state,must(Ledger.createLedger(b)).state);
});
test('one MP completion followed by gauge records has ordinal1, not recordcount',()=>{
  const f=first();f.record.all_moves.push(gauge(),gauge());const view=must(Ledger.inspectLedger(f.state,f.record));
  assert.equal(view.record_move_count,3);assert.equal(view.state.completed_turns,1);assert.equal(view.last_completion.record_move_count,1);assert.deepEqual(view.effects,[]);
});
test('multirecord battle, KO/P.C. and gauge processing produce only one additional completion',()=>{
  const f=first();f.record.all_moves.push(gauge(),declaration(),spin());
  assert.equal(must(Ledger.inspectLedger(f.state,f.record)).state.completed_turns,1);
  for(const changes of [{finalized:false},{pending_choice:true},{pending_callbacks:1}]){
    const input={...facts(f.record,'resolved_battle','white',2,3),...changes};assert.equal(Ledger.proposeCompletion(f.record,input).ok,false);
  }
  f.record.all_moves.push(move('neither','knockedout_move',{pokemon:0,index:43}),gauge());
  const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'resolved_battle','white',2,3))).cause;
  const result=must(Ledger.commitCompletion(f.state,cause,f.record));assert.equal(result.state.completed_turns,2);
  assert.equal(result.completion.action_record_index,3);assert.equal(result.completion.record_move_count,6);assert.deepEqual(result.effects,[]);
});
test('empty ledger can inspect P.C. records without owning positions or timer constraints',()=>{
  const r=base(),s=must(Ledger.createLedger(r)).state;r.all_moves.push(move('neither','knockedout_move',{pokemon:0,index:40}),move('neither','knockedout_move',{pokemon:6,index:43}),gauge());
  const result=must(Ledger.inspectLedger(s,r));assert.equal(result.state.completed_turns,0);assert.deepEqual(result.state,s);assert.equal(result.runtime_integrated,false);
});
for(const [kind,side,anchor] of [
  ['nonbattle_mp_move','black',mp('black')],['resolved_battle','white',spin()],['null_move','black',move('black','null_move')],
  ['declare_turn_end','white',move('white','declare_turn_end')],
  ['turn_ending_plate','white',move('white','declare_plate',{plate_id:5023,value:{type:'swap_move',pokemons:[6,7]}})],
  ['turn_ending_plate','black',move('black','declare_plate',{plate_id:5026,value:{type:'spot_move',from:29,to:1}})],
])test('explicit caller completion path '+kind+' '+anchor.value.type+' '+side,()=>{
  const r=base(),state=must(Ledger.createLedger(r)).state;r.all_moves.push(anchor,gauge());
  const cause=must(Ledger.proposeCompletion(r,facts(r,kind,side,1,0))).cause;
  const result=must(Ledger.commitCompletion(state,cause,r));assert.equal(result.state.completed_turns,1);assert.equal(result.state.completions[0].record_move_count,2);
});
test('no inferred side alternation: caller owns extra-turn finality',()=>{
  const f=first();f.record.all_moves.push(mp('black'));const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','black',2))).cause;
  assert.equal(must(Ledger.commitCompletion(f.state,cause,f.record)).state.completed_turns,2);
});
test('exact duplicate of latest cause stays effect-free after new gauge suffix',()=>{
  const f=first();f.record.all_moves.push(gauge());const before=copy(f),result=must(Ledger.commitCompletion(f.state,f.cause,f.record));
  assert.equal(result.changed,false);assert.deepEqual(result.state,f.state);assert.deepEqual(result.effects,[]);assert.deepEqual(f,before);
});
test('known exact old cause is idempotent, not rollback of later completions',()=>{
  const f=second(),result=must(Ledger.commitCompletion(f.state,f.firstCause,f.record));assert.equal(result.changed,false);assert.equal(result.state.completed_turns,2);assert.deepEqual(result.effects,[]);
});
test('a changed complete prefix at sameordinal cannot consume again',()=>{
  const f=first();f.record.all_moves.push(gauge());const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','black',1,0))).cause;
  assert.equal(Ledger.commitCompletion(f.state,cause,f.record).ok,false);
});
test('ordinal skip rejected without touching caller objects',()=>{
  const f=first();f.record.all_moves.push(mp('white'));const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','white',3))).cause;
  const before=copy({state:f.state,cause,record:f.record});assert.equal(Ledger.commitCompletion(f.state,cause,f.record).ok,false);
  assert.deepEqual({state:f.state,cause,record:f.record},before);
});
test('sameanchor cannot be repackaged as next completion after a gauge',()=>{
  const f=first();f.record.all_moves.push(gauge());const cause=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','black',2,0))).cause;
  assert.equal(Ledger.commitCompletion(f.state,cause,f.record).ok,false);
});
for(const [type,extra] of [['add_z_gauge',{}],['turn_end',{}],['declare_battle',{}],['declare_respin',{}],['knockedout_move',{index:40}],
  ['resign',{}],['z_skill',{}],['declare_plate',{value:{type:'select_pokemon',pokemon:7}}]])
  test('nonfinal/generated '+type+' cannot be an independent completion anchor',()=>{
    const r=base();r.all_moves.push(move('white',type,extra));for(const kind of Ledger.COMPLETION_KINDS)
      assert.equal(Ledger.proposeCompletion(r,facts(r,kind,'white')).ok,false);
  });
for(const side of ['black','white'])test(side+': finalized recovery declaration has one bound completion; malformed declarations remain rejected',()=>{
 const r=base(),initial=must(Ledger.createLedger(r)).state,from=side==='black'?0:6,to=6-from;
 r.all_moves.push(move(side,'declare_battle',{from_pokemon:from,to_pokemon:to}));
 const input=facts(r,'declaration_surround',side),cause=must(Ledger.proposeCompletion(r,input)).cause;
 const completed=must(Ledger.commitCompletion(initial,cause,r));assert.equal(completed.state.completed_turns,1);assert.equal(must(Ledger.commitCompletion(completed.state,cause,r)).changed,false);
 for(const value of [{type:'declare_battle'},{type:'declare_battle',from_pokemon:from,to_pokemon:from},{type:'declare_battle',from_pokemon:from,to_pokemon:12},{type:'declare_battle',from_pokemon:String(from),to_pokemon:to},{type:'declare_battle',from_pokemon:from,to_pokemon:to,extra:1}]){
  const invalid=copy(r);invalid.all_moves[0].value=value;assert.equal(Ledger.proposeCompletion(invalid,input).ok,false);
 }
});
for(const [label,change] of [
  ['schema',f=>f.schema='old'],['kind',f=>f.kind='resign'],['side',f=>f.ended_side='both'],['side coercion',f=>f.ended_side=1],
  ['ordinalzero',f=>f.ordinal=0],['ordinalfloat',f=>f.ordinal=1.5],['ordinalstring',f=>f.ordinal='1'],['ordinalbound',f=>f.ordinal=1025],
  ['countzero',f=>f.record_move_count=0],['countpastend',f=>f.record_move_count=2],['anchornegative',f=>f.action_record_index=-1],
  ['anchorpastprefix',f=>f.action_record_index=1],['finalfalse',f=>f.finalized=false],['finalmissing',f=>delete f.finalized],
  ['finalnumeric',f=>f.finalized=1],['pendingchoice',f=>f.pending_choice=true],['pendingmissing',f=>delete f.pending_choice],
  ['callback',f=>f.pending_callbacks=1],['callbacknegative',f=>f.pending_callbacks=-1],['callbackstring',f=>f.pending_callbacks='0'],
  ['extra',f=>f.trusted=true],
])test('rejects semantic facts '+label+' atomically',()=>{
  const r=base();r.all_moves.push(mp('black'));const f=facts(r);change(f);const before=copy({r,f});assert.equal(Ledger.proposeCompletion(r,f).ok,false);assert.deepEqual({r,f},before);
});
for(const [label,change]of [
  ['foreignmatch',v=>v.record.id='foreign'],['foreigndefinitions',v=>v.record.players[0].id='foreign'],['changedseed',v=>v.record.seed++],
  ['priorroute',v=>v.record.all_moves[0].value.route[1]=2],['truncated',v=>v.record.all_moves=[]],
  ['stateordinal',v=>v.state.completed_turns++],['missingcause',v=>v.state.completions=[]],['statefields',v=>v.state.positions=[40]],
  ['causeordinal',v=>v.state.completions[0].ordinal=2],['causeprefix',v=>v.state.completions[0].record_sha256='f'.repeat(64)],
  ['causedef',v=>v.state.completions[0].definition_sha256='f'.repeat(64)],['causeaction',v=>v.state.completions[0].action_sha256='f'.repeat(64)],
  ['causenonfinal',v=>v.state.completions[0].finalized=false],
])test('inspection rejects state/record '+label+' with no mutation',()=>{
  const v=first();change(v);const before=copy(v);assert.equal(Ledger.inspectLedger(v.state,v.record).ok,false);assert.deepEqual(v,before);
});
test('conflicting sameordinal anchored to another action rejects',()=>{
  const f=first();f.record.all_moves.push(mp('white'));const c=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','white',1))).cause;
  assert.equal(Ledger.commitCompletion(f.state,c,f.record).ok,false);
});
test('full JSON reconnect roundtrip and replay produce same ledger',()=>{
  const f=second(),checkpoint=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;
  const restored=must(Ledger.restoreLedger(JSON.parse(JSON.stringify(checkpoint)),JSON.parse(JSON.stringify(f.record))));
  assert.deepEqual(restored.state,f.state);assert.equal(restored.unreplayed_record_count,0);
  let state=must(Ledger.createLedger({...copy(f.record),all_moves:[]})).state;
  for(const cause of f.state.completions)state=must(Ledger.commitCompletion(state,copy(cause),f.record)).state;
  assert.deepEqual(state,restored.state);
});
test('checkpoint prefix permits later pending suffix but never counts it',()=>{
  const f=first(),cp=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;f.record.all_moves.push(gauge(),declaration(),spin());
  const restored=must(Ledger.restoreLedger(cp,f.record));assert.equal(restored.state.completed_turns,1);assert.equal(restored.verified_prefix_count,1);
  assert.equal(restored.unreplayed_record_count,3);assert.deepEqual(restored.effects,[]);
});
test('same checkpoint over current state is unchanged',()=>{
  const f=first(),cp=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;assert.equal(must(Ledger.restoreLedger(cp,f.record,f.state)).changed,false);
});
test('old checkpoint cannot roll back current completedordinal',()=>{
  const a=first(),cp=must(Ledger.snapshotLedger(a.state,a.record)).checkpoint,b=second();assert.equal(Ledger.restoreLedger(cp,b.record,b.state).ok,false);
});
test('newer valid checkpoint extends exactly matching priorhistory',()=>{
  const f=second(),cp=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;const r=must(Ledger.restoreLedger(cp,f.record,f.firstState));
  assert.equal(r.changed,true);assert.equal(r.state.completed_turns,2);
});
for(const [label,change]of [
  ['schema',c=>c.schema='old'],['encoding',c=>c.encoding='json'],['extra',c=>c.positions=[43]],['count',c=>c.record_binding.record_move_count++],
  ['hash',c=>c.record_binding.record_sha256='a'.repeat(64)],['match',c=>c.record_binding.match_id='other'],['definitions',c=>c.record_binding.definition_sha256='a'.repeat(64)],
  ['inflatedstate',c=>c.state.completed_turns=4],['stateschema',c=>c.state.schema='old'],['countstring',c=>c.record_binding.record_move_count='1'],
])test('checkpoint rejects '+label+' without mutation',()=>{
  const f=first(),cp=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;change(cp);const before=copy({cp,f});
  assert.equal(Ledger.restoreLedger(cp,f.record).ok,false);assert.deepEqual({cp,f},before);
});
test('conflicting sameordinal history in checkpoint rejected against currentstate',()=>{
  const f=first();f.record.all_moves.push(gauge());const alternative=must(Ledger.proposeCompletion(f.record,facts(f.record,'nonbattle_mp_move','black',1,0))).cause;
  const other=must(Ledger.commitCompletion(f.initial,alternative,f.record)).state,cp=must(Ledger.snapshotLedger(other,f.record)).checkpoint;
  assert.equal(Ledger.restoreLedger(cp,f.record,f.state).ok,false);
});
test('returned copies do not alias state, record or checkpoint',()=>{
  const f=second(),recordBefore=copy(f.record),stateBefore=copy(f.state),cp=must(Ledger.snapshotLedger(f.state,f.record)).checkpoint;
  const r=must(Ledger.restoreLedger(cp,f.record));r.state.completions[0].ended_side='white';cp.state.completions[1].record_move_count=0;
  assert.deepEqual(f.state,stateBefore);assert.deepEqual(f.record,recordBefore);
});
for(const value of [NaN,Infinity,1.25,undefined,()=>{},new Date(),new Map(),[,,],'\ud800'])test('canonical input rejects '+String(value),()=>{
  const r=base();r.extra=value;assert.equal(Ledger.createLedger(r).ok,false);
});
test('record getter never executes',()=>{
  let called=false;const r=base();Object.defineProperty(r,'secret',{enumerable:true,get(){called=true;return 'bad';}});
  assert.equal(Ledger.createLedger(r).ok,false);assert.equal(called,false);
});
test('engine coordinator and explicit planner checkpoint use the ledger without enabling unsupported Z rules',()=>{
  const engine=fs.readFileSync(path.join(project,'server/custom-match-engine.mjs'),'utf8'),planner=fs.readFileSync(path.join(project,'src/domain/match_move_planner.gd'),'utf8');
  assert.ok(engine.includes('completed-turn-ledger.mjs'));
  assert.ok(planner.includes('match_completed_turn_ledger.gd'));
  assert.ok(planner.includes('func project_completed_turn_ledger('));
  assert.match(engine,/supported_skill_ids:\s*\[1715, 1717\]/u);
});
