import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as hooks,customMatchContract as contract} from './custom-match-engine.mjs';
import {surroundingPlan} from './surrounding.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const study=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/surround-study.json',import.meta.url)));
const side=p=>p<6?'black':'white',enemy=p=>p<6?6:0;
const adjacent=p=>contract.fieldEdges.flatMap(([a,b])=>a===p?[b]:b===p?[a]:[]);
function fixture(t){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('surround-isolated'),errors=[];
 service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[{id:1199,color:1,speed_or_damage:50,range:96}];}}
 t.after(()=>{match.phase='finished'});
 const figure=p=>match.record.players.flatMap(row=>row.pokemons).find(f=>f.pokemon_index===p);
 return {service,match,errors,figure,send(move){service.acceptPlayerMove(match,move,move.selective_side)},plan(){return surroundingPlan(match.record,match.positions,match.conditions,contract.fieldEdges)}};
}
function ring(f,owner,point){
 const target=enemy(owner),neighbors=adjacent(point);
 const closing=neighbors.find(to=>to!==(owner===0?3:24)&&adjacent(to).some(from=>from!==point&&!neighbors.includes(from)));
 assert.notEqual(closing,undefined);
 const from=adjacent(closing).find(p=>p!==point&&!neighbors.includes(p));
 f.match.positions.set(target,point);f.match.positions.set(owner,from);
 let next=owner+1;for(const p of neighbors)if(p!==closing)f.match.positions.set(next++,p);
 f.match.turn=side(owner);return {target,closing,from,move:{selective_side:side(owner),value:{type:'mp_move',route:[from,closing]}}};
}
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],ledger:m.completedTurnLedger,turn:m.turn});
for(const owner of [0,6])for(let point=0;point<28;point++)test(`${owner}: actual movement surrounds at board point ${point} with all ${adjacent(point).length} neighbors`,t=>{
 const f=fixture(t),r=ring(f,owner,point);assert.deepEqual(f.plan().targets,[]);
 assert(hooks.validateMovement(f.match,side(owner),r.move));f.send(r.move);assert.deepEqual(f.errors,[]);
 assert.equal(f.match.positions.get(r.target),r.target<6?41:43);assert.equal(f.match.conditions.get(r.target),'normal');
 assert.equal(new Set(f.match.positions.values()).size,12);assert.deepEqual(f.match.pendingBattles,[]);assert.equal(f.match.turn,side(r.target));
 assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);
 assert(!f.match.record.all_moves.some(m=>['spin','declare_battle'].includes(m.value.type)));
 const after=snapshot(f.match);f.send(r.move);assert.deepEqual(f.errors,['stale_player_turn']);assert.equal(snapshot(f.match),after);
});
for(const owner of [0,6])for(const ability of [1010,1122,1261,1437])test(`${owner}: surround-only immunity ${ability} keeps victim available for battle`,t=>{
 const f=fixture(t),r=ring(f,owner,owner===0?11:15);f.figure(r.target).pokepower=ability;
 f.send(r.move);assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(r.target),owner===0?11:15);assert.equal(f.match.turn,side(owner));
 assert(f.match.pendingBattles.some(m=>m.value.to_pokemon===r.target));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,0);
});
for(const owner of [0,6])test(`${owner}: empty, allied, unavailable and gaseous contributor gaps prevent surrounding; Wait and Attack-only protection do not`,t=>{
 for(const mode of ['empty','ally','sleep','freeze','melt','faint','1010','1122','wait','1143','1427','1429']){
  const f=fixture(t),r=ring(f,owner,owner===0?11:15),p=owner+1;
  if(mode==='empty')f.match.positions.set(p,28+p);
  else if(mode==='ally'){f.match.positions.set(enemy(owner)+1,f.match.positions.get(p));f.match.positions.set(p,28+p);}
  else if(mode==='wait')f.match.waits.set(p,4);
  else if(['1010','1122'].includes(mode))f.figure(p).pokepower=Number(mode);
  else if(['1143','1427','1429'].includes(mode))f.figure(r.target).pokepower=Number(mode);
  else f.match.conditions.set(p,mode);
  f.send(r.move);assert.deepEqual(f.errors,[],mode);
  const knocked=['wait','1143','1427','1429'].includes(mode);assert.equal(f.match.positions.get(r.target)>=40,knocked,mode);
 }
});
for(const owner of [0,6])test(`${owner}: unresolved surround replacements and invalid Center occupancy reject before mutation`,t=>{
 for(const ability of [1054,1475,1231,1261,1404]){
  const f=fixture(t),r=ring(f,owner,owner===0?11:15);f.figure([1054,1475].includes(ability)?r.target:owner+1).pokepower=ability;
  const before=snapshot(f.match);assert.equal(hooks.validateMovement(f.match,side(owner),r.move),false);f.send(r.move);
  assert.deepEqual(f.errors,['illegal_player_movement']);assert.equal(snapshot(f.match),before);
 }
 const f=fixture(t),r=ring(f,owner,owner===0?11:15),old=r.target+1,upper=r.target<6?41:43;
 f.match.positions.set(old,upper-1);f.match.positions.set(old+1,upper);f.match.positions.set(old+2,28+old);
 const before=snapshot(f.match);f.send(r.move);assert.deepEqual(f.errors,['illegal_player_movement']);assert.equal(snapshot(f.match),before);
});
for(const owner of [0,6])test(`${owner}: full P.C. releases oldest, cleans debuffs/history and ages release Wait exactly once`,t=>{
 const f=fixture(t),r=ring(f,owner,owner===0?11:15),old=r.target+1,newer=r.target+2,upper=r.target<6?41:43;
 f.match.positions.set(old,upper-1);f.match.positions.set(newer,upper);
 for(const p of [r.target,old]){f.match.conditions.set(p,'poison');f.match.waits.set(p,3);f.match.battledAfterField.set(p,true);f.match.disabledSkills.set(p,new Set([1199]));}
 f.send(r.move);assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(r.target),upper);assert.equal(f.match.positions.get(newer),upper-1);assert.equal(f.match.positions.get(old),28+old);
 assert.equal(f.match.waits.get(old),1);assert.equal(f.match.waits.get(r.target),2);
 for(const p of [r.target,old]){assert.equal(f.match.conditions.get(p),'normal');assert.equal(f.match.battledAfterField.get(p),false);assert.equal(f.match.disabledSkills.has(p),false);}
});
for(const route of study.planned_closing_routes)test(`${route.owner}: full legal approach and closing route uses actual service without a synthetic battle`,t=>{
 const f=fixture(t);for(const [index,move] of route.actions.entries()){
  assert.equal(f.match.turn,move.selective_side,`turn at ${index}`);if(move.value.type==='mp_move')assert(hooks.validateMovement(f.match,move.selective_side,move),`legal MP ${index}`);
  f.send(move);assert.deepEqual(f.errors,[],`action ${index}`);assert.equal(new Set(f.match.positions.values()).size,12);
 }
 assert.equal(f.match.positions.get(route.target),route.target<6?41:43);assert.deepEqual(f.match.pendingBattles,[]);
 assert.equal(f.match.turn,side(route.target));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,route.actions.length-1);
});
for(const owner of [0,6])test(`${owner}: two victims are snapshotted before either leaves and enter P.C. in the documented derived order`,t=>{
 const f=fixture(t),opponent=enemy(owner),point=owner===0?6:21,reflection=p=>owner===0?p:27-p;
 // Closing6 simultaneously fills the missing neighbor of opponents5 and11.
 f.match.positions.set(owner,reflection(10));f.match.positions.set(owner+1,reflection(4));f.match.positions.set(owner+2,reflection(15));
 f.match.positions.set(opponent,reflection(5));f.match.positions.set(opponent+1,reflection(11));f.match.turn=side(owner);
 const move={selective_side:side(owner),value:{type:'mp_move',route:[reflection(10),point]}};
 f.send(move);assert.deepEqual(f.errors,[]);const upper=opponent<6?41:43;
 assert.equal(f.match.positions.get(opponent),upper-1);assert.equal(f.match.positions.get(opponent+1),upper);assert.equal(f.match.turn,side(opponent));
});
test('seeded board masks agree with independent incidence-matrix enclosure oracle',t=>{
 const f=fixture(t),matrix=Array.from({length:28},()=>Array(28).fill(false));for(const [a,b] of contract.fieldEdges)matrix[a][b]=matrix[b][a]=true;
 let state=0x53555252;const random=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*max)};
 for(let n=0;n<1024;n++){
  const points=Array.from({length:28},(_,i)=>i);for(let p=0;p<12;p++){const point=points.splice(random(points.length),1)[0];f.match.positions.set(p,random(4)?point:28+p);}
  const expected=[];for(let p=0;p<12;p++){const point=f.match.positions.get(p);if(point>=28)continue;
   const reachable=matrix[point].map((yes,index)=>yes?index:-1).filter(p=>p>=0);
   if(reachable.every(point=>[...f.match.positions].some(([q,position])=>position===point&&Math.floor(q/6)!==Math.floor(p/6))))expected.push(p);
  }
  assert.deepEqual(f.plan().targets,expected,`case ${n}`);
 }
});
