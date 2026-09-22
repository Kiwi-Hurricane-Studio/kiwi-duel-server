import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {movementTransitContext,benchSpotEntryTargets,holderMovementTransitGrant,canAbilityTransit} from './movement-transit.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/floating-candle-contract.json',import.meta.url)));
const side=p=>p<6?'black':'white',other=p=>p<6?6:0;
function fixture(owner=0,record=null){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('floating-candle-private');
 match.record=structuredClone(record??contract.cases.find(c=>c.owner===owner).record);match.record.all_moves=[];
 match.turn=match.record.first_player;match.turns={black:0,white:0};match.phase='started';match.socket={destroyed:false,write(){},destroy(){}};
 const errors=[],sent=[];service.rejectPlayerMove=(_m,e)=>errors.push(e);service.sendSequenced=(_m,message)=>sent.push(message);service.playOpponentTurn=()=>{};
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p);
 return {service,match,errors,sent,figure,send(move){service.acceptPlayerMove(match,move,move.selective_side)},context(){return movementTransitContext(match.record,match.positions,match.conditions,customMatchContract.fieldEdges,match.waits)}};
}
for(const c of contract.cases)test(`native Litwick legal history: ${c.name}`,t=>{
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const f=fixture(c.owner,c.record);
 for(const move of c.record.all_moves){
  if(move.value.type==='spot_move'){
   const choices=engine.legalBenchEntryMoves(f.match,move.selective_side,{allowedPokemon:c.owner});
   if(c.choices_before)assert.deepEqual(choices,c.choices_before);
   assert(engine.validateBenchEntryMove(f.match,move.selective_side,move));
   assert.equal(engine.legalRoutes(f.match,move.selective_side,{allowedPokemon:c.owner}).length,0);
  }
  f.send(move);assert.deepEqual(f.errors,[],JSON.stringify(move));
  assert.equal(new Set(f.match.positions.values()).size,12);
 }
 assert.deepEqual(Object.fromEntries(f.match.positions),c.expected.positions);
 assert.equal(f.match.turn,c.expected.turn);assert.equal(f.service.selectionSide(f.match),c.expected.selective_side);
 assert.deepEqual(f.match.pendingBattles,[]);assert.equal(f.match.waits.get(c.owner)??0,c.expected.waits[c.owner]);
 const ledger=inspectLedger(f.match.completedTurnLedger,f.match.record);assert(ledger.ok);assert.equal(ledger.state.completions.at(-1).kind,'nonbattle_spot_move');
 assert.equal(ledger.state.completed_turns,c.record.all_moves.filter(m=>['mp_move','spot_move','declare_turn_end'].includes(m.value.type)).length);
 const before=JSON.stringify({record:f.match.record,ledger:f.match.completedTurnLedger,points:[...f.match.positions]});f.send(c.action);assert.equal(f.errors.pop(),'stale_player_turn');assert.equal(JSON.stringify({record:f.match.record,ledger:f.match.completedTurnLedger,points:[...f.match.positions]}),before);
 f.match.phase='finished';
});
for(const c of contract.debug_state_cases)test(`native debug eligibility (no lifecycle claim): p${c.owner} ${c.name}`,()=>{
 const f=fixture(c.owner);const original=f.match.positions.get(c.owner),occupant=[...f.match.positions].find(([p,point])=>p!==c.owner&&point===c.source)?.[0];
 if(occupant!==undefined)f.match.positions.set(occupant,original);
 f.match.positions.set(c.owner,c.source);f.match.conditions.set(c.owner,c.circle);f.match.waits.set(c.owner,c.wait);
 assert.deepEqual(engine.legalBenchEntryMoves(f.match,side(c.owner),{allowedPokemon:c.owner}),c.choices);
 assert.deepEqual(engine.legalRoutes(f.match,side(c.owner),{allowedPokemon:c.owner}),c.ordinary_routes);
 f.match.phase='finished';
});
for(const owner of [0,6]){
 test(`p${owner}: bench entry rejects invalid actor, target, phase and selected plate atomically`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const f=fixture(owner),enemy=other(owner),source=28+owner;
  const move=(from,to)=>({selective_side:side(owner),value:{from,to,type:'spot_move'}});
  const snapshot=()=>JSON.stringify({record:f.match.record,ledger:f.match.completedTurnLedger,positions:[...f.match.positions],waits:[...f.match.waits],conditions:[...f.match.conditions]});
  for(const [from,to] of [[source,-1],[source,28],[source,owner===0?21:0],[28+owner+1,contract.targets[side(owner)][0]],[28+enemy,contract.targets[side(owner)][0]],[source,'16'],[source,16.5]]){
   const before=snapshot();f.send(move(from,to));assert.equal(f.errors.pop(),to===16.5?'completion_record_invalid':'illegal_player_spot_move');assert.equal(snapshot(),before);
  }
  const target=contract.targets[side(owner)][0];f.match.positions.set(enemy,target);const before=snapshot();f.send(move(source,target));assert.equal(f.errors.pop(),'illegal_player_spot_move');assert.equal(snapshot(),before);f.match.positions.set(enemy,28+enemy);
  f.match.pendingPlate={side:side(owner),pokemon:owner+1,plateId:5015};assert(!engine.validateBenchEntryMove(f.match,side(owner),move(source,target)));f.match.pendingPlate=null;
  f.match.battleResolutionPending=true;const pending=snapshot();f.send(move(source,target));assert.equal(f.errors.pop(),'battle_resolution_pending');assert.equal(snapshot(),pending);f.match.battleResolutionPending=false;
  f.match.waits.set(owner+1,3);f.send(move(source,target));assert.deepEqual(f.errors,[]);assert.equal(f.match.waits.get(owner+1),2);assert.equal(f.match.turn,side(enemy));f.match.phase='finished';
 });
 test(`p${owner}: allied field transit belongs to Litwick's occupied point`,()=>{
  const f=fixture(owner),mover=owner+1,route=owner===0?[15,11,6]:[11,15,20];f.match.turns={black:1,white:1};f.match.positions.set(mover,route[0]);f.match.positions.set(owner,route[1]);
  const move={selective_side:side(owner),value:{route,type:'mp_move'}};
  for(const condition of ['normal','sleep','freeze','melt','panic','paralyze','burn','poison','bad_poison']){
   f.match.conditions.set(owner,condition);f.match.waits.set(owner,5);assert.deepEqual(holderMovementTransitGrant(f.context(),mover,owner),{source:owner,pokepower:1273});assert(canAbilityTransit(f.context(),mover,owner));assert(engine.validateMovement(f.match,side(owner),move));
  }
  assert(!engine.validateMovement(f.match,side(owner),{...move,value:{route:route.slice(0,2),type:'mp_move'}}));
  f.match.positions.set(mover,28+mover);assert.equal(holderMovementTransitGrant(f.context(),mover,owner),null);
  f.match.positions.set(mover,route[0]);f.match.positions.set(owner,28+owner);assert.equal(holderMovementTransitGrant(f.context(),mover,owner),null);
  f.match.positions.set(other(owner),route[1]);f.figure(other(owner)).pokepower=1273;assert(!canAbilityTransit(f.context(),mover,other(owner)));f.match.phase='finished';
 });
}
