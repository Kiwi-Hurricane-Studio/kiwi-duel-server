import test from 'node:test';
import assert from 'node:assert/strict';
import * as Ledger from '../completed-turn-ledger.mjs';
import {canonicalToken} from '../timed-exclusion-state.mjs';
const copy=value=>structuredClone(value);
const must=result=>{assert.equal(result.ok,true,result.reason);return result;};
const move=(side,type,extra={})=>({selective_side:side,value:{type,...extra}});
function base(){return {id:'synthetic-batch-ledger',seed:563,version:1,
 players:[{color:'black',id:'black-fixture',pokemons:[]},{color:'white',id:'white-fixture',pokemons:[]}],all_moves:[]};}
function fact(ordinal,kind,side,index,count){return {schema:Ledger.FACT_SCHEMA,ordinal,kind,ended_side:side,
 action_record_index:index,record_move_count:count,finalized:true,pending_choice:false,pending_callbacks:0};}
function mixed(){const record=base();record.all_moves=[
 move('black','mp_move',{route:[0,1]}),move('neither','add_z_gauge'),
 move('white','declare_battle'),move('both','spin'),move('neither','knockedout_move',{to:43}),
 move('black','null_move'),move('white','declare_plate',{value:{type:'selection',pokemons:[7]}}),
 move('white','declare_turn_end'),move('black','declare_plate',{value:{type:'swap_move',pokemons:[0,1]}}),
 move('neither','add_z_gauge')];
 return {record,facts:[fact(1,'nonbattle_mp_move','black',0,1),fact(2,'resolved_battle','white',3,5),
  fact(3,'null_move','black',5,6),fact(4,'declare_turn_end','white',7,8),fact(5,'turn_ending_plate','black',8,9)]};}
function sequential(record,facts){let state=must(Ledger.createLedger({...copy(record),all_moves:[]})).state;
 for(const row of facts){const cause=must(Ledger.proposeCompletion(record,row)).cause;
  state=must(Ledger.commitCompletion(state,cause,record)).state;}return state;}
function expectRejected(record,facts){const before=copy({record,facts}),result=Ledger.replayCompletions(record,facts);
 assert.equal(result.ok,false);assert.equal(Object.hasOwn(result,'state'),false);assert.equal(Object.hasOwn(result,'effects'),false);
 assert.deepEqual({record,facts},before);}

test('batch matches sequential mixed completion causes including delayed spin anchor and gauge suffix',()=>{
 const {record,facts}=mixed(),before=copy({record,facts}),result=must(Ledger.replayCompletions(record,facts));
 assert.deepEqual(result,{ok:true,reason:'',changed:true,state:sequential(record,facts),effects:[]});
 assert.equal(result.state.completed_turns,5);assert.equal(result.state.completions[1].action_record_index,3);
 assert.equal(result.state.completions[1].record_move_count,5);assert.deepEqual({record,facts},before);
});
test('empty genesis batch matches createLedger exactly',()=>{
 const record=base();assert.deepEqual(must(Ledger.replayCompletions(record,[])),must(Ledger.createLedger(record)));
});
test('pending-only journal can remain empty but does not certify caller completeness',()=>{
 const record=base();record.all_moves=[move('white','declare_battle'),move('neither','add_z_gauge')];
 const result=must(Ledger.replayCompletions(record,[]));assert.equal(result.state.completed_turns,0);
 assert.deepEqual(result.state,must(Ledger.createLedger({...copy(record),all_moves:[]})).state);
 assert.deepEqual(result.effects,[]);
});
test('returned state and effects do not alias record or journal',()=>{
 const {record,facts}=mixed(),before=copy({record,facts}),a=must(Ledger.replayCompletions(record,facts));
 a.state.completions[0].kind='changed';a.effects.push({type:'synthetic-mutation'});
 assert.deepEqual({record,facts},before);assert.notEqual(must(Ledger.replayCompletions(record,facts)).state.completions[0].kind,'changed');
});
test('frozen source objects are accepted without mutation',()=>{
 const {record,facts}=mixed();function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
 must(Ledger.replayCompletions(freeze(record),freeze(facts)));
});
test('JSON numeric roundtrip and reordered object keys produce identical typed state',()=>{
 const {record,facts}=mixed(),reordered=Object.fromEntries(Object.entries(record).reverse());
 assert.equal(canonicalToken(must(Ledger.replayCompletions(record,facts)).state),canonicalToken(must(Ledger.replayCompletions(JSON.parse(JSON.stringify(reordered)),JSON.parse(JSON.stringify(facts)))).state));
});
test('a record definition change is rebound, never confused with the earlier ledger identity',()=>{
 const {record,facts}=mixed(),a=must(Ledger.replayCompletions(record,facts)).state;record.seed++;
 const b=must(Ledger.replayCompletions(record,facts)).state;assert.notEqual(a.definition_sha256,b.definition_sha256);
 assert.equal(Ledger.inspectLedger(a,record).ok,false);
});
test('record suffix changes preserve already bound completion prefixes',()=>{
 const {record,facts}=mixed(),a=must(Ledger.replayCompletions(record,facts)).state;
 record.all_moves.push(move('white','declare_battle'));assert.deepEqual(must(Ledger.replayCompletions(record,facts)).state,a);
});
test('batch state is checkpoint/restore compatible with unchanged public APIs',()=>{
 const {record,facts}=mixed(),state=must(Ledger.replayCompletions(record,facts)).state;
 const checkpoint=must(Ledger.snapshotLedger(state,record)).checkpoint;
 assert.deepEqual(must(Ledger.restoreLedger(checkpoint,record)).state,state);
});
for(const [label,change]of [
 ['skipped ordinal',v=>v.facts[2].ordinal=4],['initial ordinal not one',v=>v.facts[0].ordinal=2],
 ['reversed facts',v=>v.facts.reverse()],['duplicate ordinal',v=>v.facts[2].ordinal=2],
 ['repeated anchor',v=>{v.facts[2]=fact(3,'nonbattle_mp_move','black',0,6);}],
 ['nonincreasing prefix',v=>v.facts[2].record_move_count=5],['anchor beyond prefix',v=>v.facts[0].action_record_index=1],
 ['omitted middle completion without renumbering',v=>v.facts.splice(2,1)],
 ['fractional ordinal',v=>v.facts[0].ordinal=1.5],['fractional prefix',v=>v.facts[0].record_move_count=1.5],
 ['fractional anchor',v=>v.facts[0].action_record_index=.5],['string ordinal',v=>v.facts[0].ordinal='1'],
 ['boolean ordinal',v=>v.facts[0].ordinal=true],['null ordinal',v=>v.facts[0].ordinal=null],
 ['nonfinite ordinal',v=>v.facts[0].ordinal=Infinity],['NaN count',v=>v.facts[0].record_move_count=NaN],
 ['unfinalized',v=>v.facts[0].finalized=false],['pending choice',v=>v.facts[0].pending_choice=true],
 ['pending callback',v=>v.facts[0].pending_callbacks=1],['extra trusted cache',v=>v.facts[0].trusted_cache={}],
 ['missing schema',v=>delete v.facts[0].schema],['terminal resign kind',v=>v.facts[0].kind='resign'],
 ['gauge anchor',v=>v.facts[0]=fact(1,'null_move','neither',1,2)],
 ['changed action type',v=>v.record.all_moves[0].value.type='declare_battle'],
 ['changed action side',v=>v.record.all_moves[0].selective_side='white'],
 ['invalid record id',v=>v.record.id=1],['invalid player order',v=>v.record.players.reverse()],
 ['truncated record',v=>v.record.all_moves=[]],
 ['excess facts',v=>v.facts=Array.from({length:Ledger.MAX_COMPLETIONS+1},()=>copy(v.facts[0]))],
 ['excess moves',v=>v.record.all_moves=Array.from({length:Ledger.MAX_RECORD_MOVES+1},()=>move('black','null_move'))],
])test('batch rejects '+label+' without partial state',()=>{const v=mixed();change(v);expectRejected(v.record,v.facts);});
for(const [label,value]of [['null',null],['object',{}],['string','facts'],['number',1],['boolean',true],['sparse',[,]]])
 test('rejects journal '+label,()=>{expectRejected(base(),value);});
test('journal/fact getters are rejected without execution',()=>{
 let calls=0;const {record,facts}=mixed();Object.defineProperty(facts[0],'ordinal',{enumerable:true,get(){calls++;return 1;}});
 assert.equal(Ledger.replayCompletions(record,facts).ok,false);assert.equal(calls,0);
});
test('moderate synthetic history batch equals sequential state, not a performance threshold',()=>{
 const record=base(),facts=[];for(let i=0;i<24;i++){const side=i%2?'white':'black';record.all_moves.push(move(side,'null_move'));
  facts.push(fact(i+1,'null_move',side,i,i+1));}
 assert.deepEqual(must(Ledger.replayCompletions(record,facts)).state,sequential(record,facts));
});
