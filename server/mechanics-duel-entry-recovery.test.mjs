import test from 'node:test';import assert from 'node:assert/strict';
import {CustomMatchService,customMatchTestHooks as hooks,customMatchContract} from './custom-match-engine.mjs';
import {fieldEntryRecoveryPlan} from './field-entry-recovery.mjs';
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const conditions=[...special,'normal','faint'];
const binding={1207:1095,1377:1452,1383:1005}; // 1383 has no catalog binding: synthetic ability fixture only.
const cures=(ability,condition)=>ability===1207?special.includes(condition):condition==='burn';
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],history:[...m.battledAfterField],disabled:[...m.disabledSkills],ledger:m.completedTurnLedger,plates:m.plateState});
function fixture(t,owner,ability){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('duel-entry-recovery-isolated'),errors=[],enemy=owner===0?6:0,side=owner===0?'black':'white',rotate=p=>owner===0?p:27-p;
 match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 for(const player of match.record.players){player.plates=[5023,5026];for(const f of player.pokemons){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[{id:1199,color:1,range:96,speed_or_damage:50}];}}
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p);figure(owner).id=binding[ability];figure(owner).pokepower=ability;match.turn=side;
 match.positions.set(owner+1,rotate(11));match.positions.set(owner+2,rotate(10));match.positions.set(owner+4,owner===0?41:43);match.positions.set(owner+5,-1);match.positions.set(enemy,rotate(5));
 for(const p of [owner+1,owner+3,owner+4,owner+5,enemy]){match.conditions.set(p,'burn');match.waits.set(p,4);match.battledAfterField.set(p,true);match.disabledSkills.set(p,new Set([1199]));}
 hooks.ensurePlateState(match);t.after(()=>{match.phase='finished'});
 return {service,match,errors,owner,enemy,side,rotate,figure,send(move){service.acceptPlayerMove(match,move,move.selective_side)}};
}
function movement(f,kind){return {selective_side:f.side,value:kind==='mp'?{type:'mp_move',route:[28+f.owner,f.rotate(27)]}:{type:'declare_plate',plate_id:kind==='switch'?5023:5026,value:kind==='switch'?{type:'swap_move',pokemons:[f.owner,f.owner+2]}:{type:'spot_move',from:28+f.owner,to:f.rotate(20)}}};}
for(const owner of [0,6])for(const ability of [1207,1377,1383])for(const kind of ['mp','throw','switch'])test(`${owner}: entry ${ability} ${kind} cures native field targets and preserves bench and Center conditions`,t=>{
 for(const prior of conditions){
  const f=fixture(t,owner,ability),m=f.match;for(const p of [owner+1,owner+3,owner+4,owner+5,f.enemy])m.conditions.set(p,prior);
  const before=new Map(m.positions),history=new Map(m.battledAfterField);f.send(movement(f,kind));assert.deepEqual(f.errors,[],prior);
  for(let p=0;p<12;p++){
   const selected=p===owner+1,affected=[owner+1,owner+3,owner+4,owner+5,f.enemy].includes(p);
   assert.equal(m.conditions.get(p),selected&&cures(ability,prior)?'normal':affected?prior:'normal',`${p} ${prior}`);
   assert.equal(m.waits.get(p),affected?3:0,'recovery preserves Wait before one turn aging');
   assert.equal(m.battledAfterField.get(p),p===owner||kind==='switch'&&p===owner+2?false:history.get(p));
   if(p!==owner&&!(kind==='switch'&&p===owner+2))assert.equal(m.positions.get(p),before.get(p));
  }
  assert.equal(m.completedTurnLedger.completed_turns,1);assert.equal(new Set([...m.positions.values()].filter(p=>p>=0)).size,11);
  const settled=snapshot(m);f.send(movement(f,kind));assert.deepEqual(f.errors,['stale_player_turn']);assert.equal(snapshot(m),settled);
 }
});
for(const owner of [0,6])for(const ability of [1207,1377,1383])test(`${owner}: duel entry ${ability} source scope condition filtering and stable ordering`,t=>{
 const f=fixture(t,owner,ability),m=f.match,before=new Map(m.positions),after=new Map(before);after.set(owner,f.rotate(27));m.conditions.set(owner,'burn');m.waits.set(owner,5);
 const expected=[{source:owner,ability,condition_targets:[owner,owner+1],wait_targets:[]}];
 assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,after,m.conditions,m.waits),expected);
 const reversed=structuredClone(m.record);reversed.players.reverse();for(const p of reversed.players)p.pokemons.reverse();assert.deepEqual(fieldEntryRecoveryPlan(reversed,before,after,m.conditions,m.waits),expected);
 for(const origin of [28+owner,28+owner+5]){const b=new Map(before);b.set(owner,origin);assert.deepEqual(fieldEntryRecoveryPlan(m.record,b,after,m.conditions,m.waits),expected);}
 for(const origin of [-1,0,27,40,41,42,43,28+f.enemy]){const b=new Map(before);b.set(owner,origin);assert.deepEqual(fieldEntryRecoveryPlan(m.record,b,after,m.conditions,m.waits),[]);}
 for(const destination of [-1,28+owner,40,41,42,43]){const a=new Map(after);a.set(owner,destination);assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,a,m.conditions,m.waits),[]);}
 for(const p of [owner,owner+1,owner+3,owner+4])m.conditions.set(p,'curse');assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,after,m.conditions,m.waits),[],'Curse cannot masquerade as special condition');
 m.conditions.set(owner+1,'burn');const wrong=new Map(after);wrong.set(owner+1,28+f.enemy);assert.deepEqual(fieldEntryRecoveryPlan(m.record,before,wrong,m.conditions,m.waits),[],'invalid opposing bench is not a holder-owned duel zone');
});
for(const owner of [0,6])for(const ability of [1207,1377,1383])test(`${owner}: duel entry ${ability} occupied plate rejection leaves recovery and plate untouched`,t=>{
 const f=fixture(t,owner,ability),move=movement(f,'throw');move.value.value.to=f.rotate(11);const before=snapshot(f.match);f.send(move);assert.deepEqual(f.errors,['illegal_player_plate']);assert.equal(snapshot(f.match),before);
});
for(const owner of [0,6])test(`${owner}: Purification recovery precedes surround and unresolved surround rejects the entire entry`,t=>{
 const f=fixture(t,owner,1207);f.match.positions.set(f.enemy,f.rotate(15));f.match.conditions.set(f.enemy,'normal');f.match.conditions.set(owner+1,'sleep');f.send(movement(f,'throw'));
 assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(f.enemy),f.enemy===0?41:43);assert.equal(f.match.conditions.get(owner+1),'normal');
 const invalid=fixture(t,owner,1207);invalid.match.positions.set(invalid.enemy,invalid.rotate(15));invalid.figure(invalid.enemy).pokepower=1054;invalid.match.conditions.set(owner+1,'sleep');const before=snapshot(invalid.match);invalid.send(movement(invalid,'throw'));assert.deepEqual(invalid.errors,['illegal_player_plate']);assert.equal(snapshot(invalid.match),before);
});
for(const ability of [1207,1377,1383])test(`training opponent applies duel recovery ${ability} through actual Long Throw`,t=>{
 const f=fixture(t,6,ability);f.service.chooseObservedOpponentPlate=()=>movement(f,'throw');CustomMatchService.prototype.playOpponentTurn.call(f.service,f.match);assert.deepEqual(f.errors,[]);assert.equal(f.match.conditions.get(7),'normal');for(const p of [9,10,11])assert.equal(f.match.conditions.get(p),'burn');assert.equal(f.match.turn,'black');
});
for(const owner of [0,6])for(const ability of [1207,1377,1383])test(`${owner}: seeded duel recovery ${ability} covers64 real MP actions`,t=>{
 let seed=(0x63cd0000+owner+ability)>>>0;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
 for(let iteration=0;iteration<64;iteration++){
  const f=fixture(t,owner,ability),m=f.match,entry=f.rotate(27),available=Array.from({length:28},(_,p)=>p).filter(p=>p!==entry),centers=[40,41,42,43];
  for(let p=0;p<12;p++)if(p!==owner){f.figure(p).pokepower=1122;f.figure(p).id=1192;const zone=random(4);const center=centers.find(c=>(c<42)===(p<6));m.positions.set(p,zone===0?28+p:zone===1?-1:zone===2&&center!==undefined?centers.splice(centers.indexOf(center),1)[0]:available.splice(random(available.length),1)[0]);m.conditions.set(p,conditions[random(conditions.length)]);m.waits.set(p,random(6));}
  const before={points:new Map(m.positions),conditions:new Map(m.conditions),waits:new Map(m.waits)};
  const adjacent=[...before.points].some(([p,point])=>Math.floor(p/6)!==Math.floor(owner/6)&&point>=0&&point<28&&customMatchContract.fieldEdges.some(([a,b])=>a===entry&&b===point||b===entry&&a===point));
  const touchTargets=[...before.points].filter(([p,point])=>p!==owner&&Math.floor(p/6)===Math.floor(owner/6)&&point>=0&&point<28&&!cures(ability,before.conditions.get(p))&&['sleep','freeze','melt'].includes(before.conditions.get(p))&&customMatchContract.fieldEdges.some(([a,b])=>a===entry&&b===point||b===entry&&a===point)).sort((a,b)=>a[1]-b[1]).map(([p])=>p);
  const pending=adjacent||touchTargets.length>0;
  f.send(movement(f,'mp'));assert.deepEqual(f.errors,[],`seed ${iteration}`);
  assert.deepEqual(f.service.touchChoices(m,f.side).map(a=>a.value.to_pokemon),touchTargets,'native-backed remaining conditions determine exact Touch targets');
  for(let p=0;p<12;p++){const selected=p!==owner&&Math.floor(p/6)===Math.floor(owner/6)&&before.points.get(p)>=0&&before.points.get(p)<28;assert.equal(m.conditions.get(p),selected&&cures(ability,before.conditions.get(p))?'normal':before.conditions.get(p));assert.equal(m.waits.get(p),Math.max(0,before.waits.get(p)-(pending?0:1)));assert.equal(m.positions.get(p),p===owner?entry:before.points.get(p));}
  assert.equal(m.completedTurnLedger.completed_turns,pending?0:1);const occupied=[...m.positions.values()].filter(p=>p>=0);assert.equal(new Set(occupied).size,occupied.length);
 }
});
