import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as hooks} from './custom-match-engine.mjs';
import {surroundingPlateNetworkCases} from '../tests/surrounding-plate-network-cases.mjs';
const native=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url)));
const cases=surroundingPlateNetworkCases(native.cases);
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],turn:m.turn,ledger:m.completedTurnLedger,plates:m.plateState});
function fixture(t){t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('surround-plates-isolated'),errors=[];
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 for(const player of match.record.players){player.plates=[5023,5026,5306];for(const f of player.pokemons){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[{id:1199,color:1,range:96,speed_or_damage:50}];}}
 t.after(()=>{match.phase='finished'});return {service,match,errors,figure:p=>match.record.players.flatMap(row=>row.pokemons).find(f=>f.pokemon_index===p),send(move){service.acceptPlayerMove(match,move,move.selective_side)}};
}
for(const scenario of cases)test(`actual candidate route ${scenario.name}`,t=>{
 const f=fixture(t);f.match.record.players=structuredClone(scenario.record.players);
 for(const [index,action] of scenario.actions.entries()){
  assert.equal(f.match.turn,action.selective_side,`side ${index}`);hooks.ensurePlateState(f.match);
  const before=snapshot(f.match);f.send({selective_side:action.selective_side,value:action.value});
  if(action.expected_rejection){assert.deepEqual(f.errors,[action.expected_rejection],`rejection ${index}`);assert.equal(snapshot(f.match),before);f.errors.length=0;}
  else assert.deepEqual(f.errors,[],`action ${index} ${JSON.stringify(action.value)}`);
  assert.equal(new Set(f.match.positions.values()).size,12);
 }
 assert.deepEqual(Object.fromEntries(f.match.positions),scenario.expected_positions);assert.equal(f.match.turn,scenario.final_turn);assert.deepEqual(f.match.pendingKnockouts,null);
 for(const p of f.match.positions.keys()){assert.equal(f.match.conditions.get(p),'normal');assert.equal(f.match.waits.get(p),0);}
 const declarations=f.match.record.all_moves.filter(m=>m.value.type==='declare_plate');assert.equal(declarations.length,scenario.actions.filter(a=>a.value.type==='declare_plate'&&!a.expected_rejection).length);
});
for(const owner of [0,6])for(const count of [0,1,2])test(`${owner}: Long Throw three-victim surround with ${count} prior Center occupants commits one plate turn`,t=>{
 const f=fixture(t),enemy=owner===0?6:0,rotate=p=>owner===0?p:27-p,side=owner===0?'black':'white';
 // Last point19 completes rings at14,18 and27 and is itself enclosed by
 // those three opponents. The documented snapshot therefore KOs BOTH sides.
 for(const [p,point]of [[owner,10],[owner+2,17],[owner+3,25],[owner+4,20],[owner+5,26],[enemy,14],[enemy+1,18],[enemy+2,27]])f.match.positions.set(p,rotate(point));
 const upper=enemy<6?41:43;if(count>0)f.match.positions.set(enemy+3,upper);if(count>1)f.match.positions.set(enemy+4,upper-1);
 for(const p of [enemy,enemy+1,enemy+2,enemy+3,enemy+4]){f.match.conditions.set(p,'poison');f.match.waits.set(p,4);f.match.battledAfterField.set(p,true);}
 f.match.turn=side;
 const move={selective_side:side,value:{type:'declare_plate',plate_id:5026,value:{type:'spot_move',from:28+owner+1,to:rotate(19)}}};
 f.send(move);assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(enemy+2),upper);assert.equal(f.match.positions.get(enemy+1),upper-1);assert.equal(f.match.positions.get(enemy),28+enemy);assert.equal(f.match.waits.get(enemy),1);
 assert.equal(f.match.positions.get(owner+1),owner===0?41:43);assert.equal(f.match.conditions.get(owner+1),'normal');
 for(const p of [enemy,enemy+1,enemy+2]){assert.equal(f.match.conditions.get(p),'normal');assert.equal(f.match.battledAfterField.get(p),false);}
 if(count>0){assert.equal(f.match.positions.get(enemy+3),28+enemy+3);assert.equal(f.match.waits.get(enemy+3),1);}
 if(count>1){assert.equal(f.match.positions.get(enemy+4),28+enemy+4);assert.equal(f.match.waits.get(enemy+4),1);}
 assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.plateState.plate_conditions.find(r=>r.color===side).plates.find(p=>p.id===5026).condition,'used');
 const before=snapshot(f.match);f.send(move);assert.deepEqual(f.errors,['stale_player_turn']);assert.equal(snapshot(f.match),before);
});
for(const kind of ['throw','goal','switch'])test(`training opponent ${kind} uses the same plate surround boundary`,t=>{
 const scenario=cases.find(c=>c.owner===6&&c.name.includes('-'+kind+'-ordinary')),f=fixture(t);f.match.record.players=structuredClone(scenario.record.players);
 for(const action of scenario.actions.slice(0,-1))f.send(action);
 assert.deepEqual(f.errors,[]);const final=scenario.actions.at(-1);
 f.service.chooseObservedOpponentPlate=()=>structuredClone(final);
 CustomMatchService.prototype.playOpponentTurn.call(f.service,f.match);
 assert.deepEqual(f.errors,[]);assert.deepEqual(Object.fromEntries(f.match.positions),scenario.expected_positions);assert.equal(f.match.turn,'black');
});
for(const owner of [0,6])test(`${owner}: two absent figures share sentinel -1 without blocking movement or Center admission`,t=>{
 const f=fixture(t),enemy=owner===0?6:0,rotate=p=>owner===0?p:27-p,side=owner===0?'black':'white';
 f.match.positions.set(owner,rotate(11));f.match.positions.set(enemy,rotate(15));
 f.match.positions.set(enemy+4,-1);f.match.positions.set(enemy+5,-1);f.match.turn=side;
 f.send({selective_side:side,value:{type:'declare_plate',plate_id:5026,value:{type:'spot_move',from:28+owner+1,to:rotate(20)}}});
 assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(enemy),enemy===0?41:43);assert.equal(f.match.positions.get(enemy+4),-1);assert.equal(f.match.positions.get(enemy+5),-1);
});
