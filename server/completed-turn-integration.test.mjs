// Actual service handlers, only synthetic in-memory matches. No listener,
// credentials, account store, endpoint, device or native oracle invocation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {CustomMatchService,customMatchTestHooks as hooks,customMatchPrimitives} from './custom-match-engine.mjs';
import {HumanMatchService} from './human-match-service.mjs';
import {inspectLedger,restoreLedger,commitCompletion} from './completed-turn-ledger.mjs';
import {canonicalDigest} from './timed-exclusion-state.mjs';

const move=(side,type,extra={})=>({selective_side:side,value:{type,...extra}});
const plate=(side,id,value)=>move(side,'declare_plate',{plate_id:id,value});
const snapshot=match=>JSON.stringify({record:match.record,ledger:match.completedTurnLedger,positions:[...match.positions],waits:[...match.waits],
 conditions:[...match.conditions],gauges:match.zGauge,turn:match.turn,turns:match.turns,plate:match.plateState,z:match.zState,
 pending:match.pendingBattles,respin:match.pendingRespin,ko:match.pendingKnockouts,resolution:match.activeBattleResolution});
function fixture(t,{human=false,units=[0,0,0]}={}){
 const callbacks=[],errors=[],writes=[];
 t.mock.method(globalThis,'setTimeout',fn=>{callbacks.push(fn);return {unref(){}};});
 const options={port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>1000,
  connectionServerFactory:()=>({listen(){assert.fail('no listener authorized');},close(fn){fn?.();}}),spinUnitSource:()=>units.shift()??0};
 const service=human?new HumanMatchService(options):new CustomMatchService(options);
 service.playOpponentTurn=()=>{};service.declareOpponentRespin=()=>{};
 const match=human?service.pair({id:78001,user:{user_id:88001,display_name:'Synthetic_A'},deck:null},
  {id:78002,user:{user_id:88002,display_name:'Synthetic_B'},deck:null}):service.createMatch('synthetic-completed-turn');
 match.phase='started';match.socket={destroyed:false,write:line=>writes.push(line),destroy:error=>errors.push(error?.message??'destroyed')};
 service.rejectPlayerMove=(_match,reason)=>errors.push(reason);
 if(human)for(const peer of match.peers){peer.ready=true;peer.session='synthetic-only-'+peer.side;
  peer.socket={destroyed:false,writable:true,write:line=>writes.push(line),end:line=>errors.push(line),destroy(){}};
  peer.connectionState={match,peer};}
 t.after(()=>{match.phase='finished';});
 return {service,match,errors,writes,callbacks,send(action){
  if(!human)return service.acceptPlayerMove(match,action,action.selective_side);
  const peer=match.peers.find(p=>p.side===action.selective_side);
  service.handleLine(peer.socket,peer.connectionState,`sequence ${peer.clientSendIndex+1} ${peer.serverSendIndex} do_move ${JSON.stringify(action)}`);
 }};
}
const ledger=match=>{const result=inspectLedger(match.completedTurnLedger,match.record);assert.equal(result.ok,true,result.reason);return result.state;};
function controlledBattle(f){
 f.match.positions.set(0,15);f.match.positions.set(7,11);
 // Explicit synthetic authored wheels before the first record; not a native
 // modifier/outcome or claim about these figures' ordinary source wheels.
 f.match.record.players[0].pokemons[0].skills=[{id:1009,color:1,range:96,speed_or_damage:30}];
 f.match.record.players[1].pokemons[1].skills=[{id:1131,color:0,range:96,speed_or_damage:0}];
 f.match.record.players[0].pokemons[0].pokepower=-1;f.match.record.players[1].pokemons[1].pokepower=-1;
}
for(const human of [false,true])test(`${human?'human':'training'} first append binds final definitions and ordinal is independent of gauge`,t=>{
 const f=fixture(t,{human});assert.equal(f.match.completedTurnLedger,null);
 const expected=structuredClone(f.match.record);delete expected.all_moves;
 f.send(move('black','mp_move',{route:[28,21]}));assert.deepEqual(f.errors,[]);
 const state=ledger(f.match);assert.equal(state.completed_turns,1);assert.equal(state.definition_sha256,canonicalDigest(expected));
 assert.equal(state.completions[0].record_move_count,1);assert.equal(state.completions[0].action_record_index,0);
 assert.equal(f.match.record.all_moves[1].value.type,'add_z_gauge');assert.equal(f.match.turn,'white');
 f.send(move('white','mp_move',{route:[34,0]}));assert.deepEqual(f.errors,[]);
 assert.equal(ledger(f.match).completed_turns,2);assert.equal(f.match.record.all_moves.length,4);
 assert.equal(ledger(f.match).completions[1].action_record_index,2);
 const cp=f.service.completedTurnCheckpoint(f.match);assert.equal(cp.ok,true);
 assert.deepEqual(restoreLedger(cp.checkpoint,structuredClone(f.match.record)).state,f.match.completedTurnLedger);
 assert.equal(customMatchPrimitives.makePlayGame(f.match).CompletedTurnState,undefined,'no unnegotiated wire advertisement');
});
test('MP approach and decline bind null, not provisional MP or next-turn gauge',t=>{
 const f=fixture(t);f.match.positions.set(0,15);f.match.positions.set(7,6);
 f.send(move('black','mp_move',{route:[15,11]}));assert.deepEqual(f.errors,[]);assert.equal(ledger(f.match).completed_turns,0);
 assert.ok(f.match.pendingBattles.length);f.send(move('black','null_move'));assert.deepEqual(f.errors,[]);
 const cause=ledger(f.match).completions[0];assert.equal(cause.kind,'null_move');assert.equal(cause.action_record_index,1);assert.equal(cause.record_move_count,2);
});
for(const [label,action,position] of [
 ['spot',plate('black',5026,{type:'spot_move',from:28,to:16}),null],
 ['swap',plate('black',5023,{type:'swap_move',pokemons:[0,1]}),16]
])test(`turn-ending ${label} plate uses declaration anchor`,t=>{
 const f=fixture(t);if(position!==null)f.match.positions.set(0,position);
 f.send(action);assert.deepEqual(f.errors,[]);const cause=ledger(f.match).completions[0];
 assert.equal(cause.kind,'turn_ending_plate');assert.equal(cause.record_move_count,1);assert.equal(cause.action_record_index,0);
});
test('selection plate and explicit end tick only on end',t=>{
 const f=fixture(t);f.send(plate('black',5022,{type:'select_pokemon',pokemon:0}));assert.equal(ledger(f.match).completed_turns,0);
 f.send(move('black','declare_turn_end'));assert.deepEqual(f.errors,[]);
 const cause=ledger(f.match).completions[0];assert.equal(cause.kind,'declare_turn_end');assert.equal(cause.action_record_index,1);assert.equal(cause.record_move_count,2);
});
for(const human of [false,true])test(`${human?'human':'training'} resolved battle keeps spin prefix before all settlement gauges`,t=>{
 const f=fixture(t,{human});controlledBattle(f);f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));
 assert.equal(ledger(f.match).completed_turns,0);assert.equal(f.callbacks.length,1);f.callbacks.shift()();assert.deepEqual(f.errors,[]);
 const state=ledger(f.match),cause=state.completions[0];assert.equal(state.completed_turns,1);assert.equal(cause.kind,'resolved_battle');
 assert.equal(cause.ended_side,'black');assert.equal(cause.action_record_index,1);assert.equal(cause.record_move_count,2);
 assert.equal(f.match.positions.get(7),43);assert.ok(f.match.record.all_moves.length>2);
 assert.ok(f.match.record.all_moves.slice(2).every(a=>a.value.type==='add_z_gauge'));
 const before=snapshot(f.match),resolution=structuredClone(f.match.activeBattleResolution);
 assert.equal(f.service.finishBattleSpin(f.match,{...resolution,attackingSide:resolution.side}),false);assert.equal(snapshot(f.match),before);
 const duplicate=commitCompletion(state,cause,f.match.record);assert.equal(duplicate.ok,true);assert.equal(duplicate.changed,false);
 assert.equal(f.service.completeTurn(f.match,'black',{ok:true,cause}),false);assert.equal(snapshot(f.match),before);
});
for(const decline of [false,true])test(`Double Chance ${decline?'decline':'respin'} retains final effective spin and one completion`,t=>{
 const f=fixture(t);controlledBattle(f);f.match.record.players[0].plates[0]=5015;
 f.send(plate('black',5015,{type:'select_pokemon',pokemon:0}));assert.deepEqual(f.errors,[]);
 f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));
 f.callbacks.shift()();assert.equal(ledger(f.match).completed_turns,0);assert.ok(f.match.pendingRespin);
 f.send(move('black',decline?'null_move':'declare_respin',decline?{}:{pokemons:[0]}));
 if(!decline){assert.equal(ledger(f.match).completed_turns,0);f.callbacks.shift()();}
 assert.deepEqual(f.errors,[]);const cause=ledger(f.match).completions[0];assert.equal(cause.kind,'resolved_battle');assert.equal(cause.ended_side,'black');
 assert.equal(cause.action_record_index,decline?2:4);assert.equal(cause.record_move_count,decline?4:5);assert.equal(f.match.pendingRespin,null);
});
function pendingRockSlide(t,{three=false,occupied=false,doubleChance=false}={}) {
 const f=fixture(t);controlledBattle(f);
 f.match.record.players[0].pokemons[0].skills=[{id:1140,color:2,range:96,speed_or_damage:1}];
 f.match.positions.set(8,6);
 if(three){f.match.positions.set(0,11);f.match.positions.set(7,6);f.match.positions.set(8,5);f.match.positions.set(9,10);}
 if(occupied)f.match.positions.set(10,43);
 for(const pokemon of three?[7,8,9]:[7,8])f.match.waits.set(pokemon,1);
 if(doubleChance){f.match.record.players[0].plates[0]=5015;f.send(plate('black',5015,{type:'select_pokemon',pokemon:0}));}
 f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));f.callbacks.shift()();
 if(doubleChance){assert.ok(f.match.pendingRespin);f.send(move('black','null_move'));}
 assert.deepEqual(f.errors,[]);assert.ok(f.match.pendingKnockouts);assert.equal(ledger(f.match).completed_turns,0);
 return f;
}
for(const options of [{},{three:true},{three:true,occupied:true},{three:true,doubleChance:true}])
test(`multi-record KO ${JSON.stringify(options)} waits for final accepted command and retains spin`,t=>{
 const f=pendingRockSlide(t,options),spinIndex=f.match.activeBattleResolution.spinRecordIndex;
 let finalCount=0,steps=0;
 while(f.match.pendingKnockouts){
  assert.ok(++steps<=5);assert.equal(ledger(f.match).completed_turns,0);
  const pending=f.match.pendingKnockouts;finalCount=f.match.record.all_moves.length+1;
  assert.equal(f.service.performPendingKnockouts(f.match,pending),true);
  const before=snapshot(f.match);assert.equal(f.service.performPendingKnockouts(f.match,pending),false);assert.equal(snapshot(f.match),before);
 }
 const cause=ledger(f.match).completions[0];assert.equal(cause.kind,'resolved_battle');assert.equal(cause.ended_side,'black');
 assert.equal(cause.action_record_index,spinIndex);assert.equal(cause.record_move_count,finalCount);
 assert.equal(f.match.turns.black,1);assert.equal(f.match.turn,'white');assert.equal(f.match.pendingRespin,null);
 assert.ok(f.match.record.all_moves.slice(finalCount).every(a=>a.value.type==='add_z_gauge'));
 if(options.three)assert.ok(steps>=3,'KO then independent Center shift then final KO');
});
for(const corruption of ['ledger','plate'])test(`pending KO ${corruption} preflight rejects before accepted record or relocation`,t=>{
 const f=pendingRockSlide(t,{three:true,occupied:true});
 if(corruption==='ledger')f.match.completedTurnLedger.completed_turns=99;
 else f.match.plateState.plate_conditions=[];
 const before=snapshot(f.match);assert.equal(f.service.performPendingKnockouts(f.match),false);assert.equal(snapshot(f.match),before);
});
for(const stage of ['before-accept','before-spin'])test(`malformed plate cleanup ${stage} is rejected before board effects`,t=>{
 const f=fixture(t);
 if(stage==='before-spin'){controlledBattle(f);f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));}
 else hooks.ensurePlateState(f.match);
 f.match.plateState.plate_conditions=[];const before=snapshot(f.match);
 assert.doesNotThrow(()=>stage==='before-spin'?f.callbacks.shift()():f.send(move('black','mp_move',{route:[28,21]})));
 assert.equal(snapshot(f.match),before);if(stage==='before-accept')assert.equal(f.errors.at(-1),'completion_record_invalid');
});
for(const reason of ['resign','goal','timeout'])test(`terminal ${reason} does not tick`,t=>{
 const f=fixture(t);
 if(reason==='resign')f.send(move('black','resign'));
 if(reason==='goal'){f.match.positions.set(0,2);f.send(move('black','mp_move',{route:[2,3]}));}
 if(reason==='timeout'){f.match.blackTimeMs=0;f.service.finish(f.match,'white','timeout');}
 assert.equal(f.match.phase,'finished');assert.equal(f.match.completedTurnLedger?.completed_turns??0,0);assert.deepEqual(f.match.turns,{black:0,white:0});
});
for(const corruption of ['missing','definition','prefix','ordinal'])test(`preflight ${corruption} fails before accepted-move mutation`,t=>{
 const f=fixture(t);f.send(move('black','mp_move',{route:[28,21]}));
 if(corruption==='missing')f.match.completedTurnLedger=null;
 if(corruption==='definition')f.match.record.seed=2;
 if(corruption==='prefix')f.match.record.all_moves[0].value.route=[28,27];
 if(corruption==='ordinal')f.match.completedTurnLedger.completed_turns=99;
 const before=snapshot(f.match);assert.doesNotThrow(()=>f.send(move('white','mp_move',{route:[34,0]})));
 assert.equal(snapshot(f.match),before);assert.equal(f.errors.at(-1),'completion_record_invalid');
});
test('corrupt ledger rejects delayed battle before outcome side effects',t=>{
 const f=fixture(t);controlledBattle(f);f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));
 f.match.completedTurnLedger.completed_turns=9;const before=snapshot(f.match);assert.doesNotThrow(()=>f.callbacks.shift()());assert.equal(snapshot(f.match),before);
});
test('invalid generated gauge rejects before gauge/record mutation',t=>{
 const f=fixture(t);const before=snapshot(f.match);assert.equal(f.service.addZGauge(f.match,{black:'not-numeric'}),null);assert.equal(snapshot(f.match),before);
});
test('large but canonical match definition cannot consume settlement headroom on acceptance',t=>{
 const f=fixture(t);f.match.record.synthetic_capacity_fixture=Array(27).fill('x'.repeat(32768));
 const before=snapshot(f.match);assert.doesNotThrow(()=>f.send(move('black','mp_move',{route:[28,21]})));
 assert.equal(snapshot(f.match),before);assert.equal(f.errors.at(-1),'completion_capacity_reached');
});
test('occupied personal return bench rejects projected Rock Slide before faint/Wait changes',t=>{
 const f=fixture(t);controlledBattle(f);
 f.match.record.players[0].pokemons[0].skills=[{id:1140,color:2,range:96,speed_or_damage:1}];
 f.match.positions.set(8,6);f.match.waits.set(7,1);f.match.waits.set(8,1);
 f.match.positions.set(9,42);f.match.positions.set(10,43);f.match.positions.set(11,37);
 f.send(move('black','declare_battle',{from_pokemon:0,to_pokemon:7}));
 // Hold the actual accepted spin before outcome planning to inspect the
 // rejected disposition separately from the already accepted declaration.
 const finish=f.service.finishBattleSpin.bind(f.service);let state;
 f.service.finishBattleSpin=(_match,value)=>{state=value;};f.callbacks.shift()();assert.ok(state);
 const before=snapshot(f.match);assert.equal(finish(f.match,state),false);assert.equal(snapshot(f.match),before);
 assert.equal(ledger(f.match).completed_turns,0);
});
test('all production completion callsites use coordinator; raw cleanup is explicitly test-only',()=>{
 assert.equal(typeof CustomMatchService.prototype.completeTurn,'function');assert.equal(typeof hooks.completeTurn,'function');
 assert.notEqual(CustomMatchService.prototype.completeTurn,hooks.completeTurn);
});
