import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract as contract} from './custom-match-engine.mjs';
import {purpleWaitPlan as plan} from './purple-wait.mjs';
const coverage=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const rules=[{id:1471,condition:'paralyze',wait:3},{id:1524,condition:'burn',wait:3},{id:1532,condition:null,wait:3},{id:1566,condition:null,wait:3},{id:1598,condition:'poison',wait:7}];
const attack=(id,color=2,power=3,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,id){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('purple-wait-isolated'),enemy=owner===0?6:0;
 const figure=p=>match.record.players.flatMap(row=>row.pokemons).find(f=>f.pokemon_index===p);
 for(const player of match.record.players)for(const f of player.pokemons){f.id=1002;f.pokepower=-1;f.skills=[attack(1199,1,50)];}
 figure(owner).skills=[attack(id)];match.positions.set(0,15);match.positions.set(6,11);match.turn=owner===0?'black':'white';
 return {service,match,figure,owner,enemy};
}
function chain(f){
 const points=f.enemy===6?[11,6,5,10,9,2]:[15,20,27,19,18,25];
 for(let n=0;n<6;n++)f.match.positions.set(f.enemy+n,points[n]);
 return points;
}
const resolve=(f,defending=false)=>f.service.applyBaseBattleOutcome(f.match,defending?f.enemy:f.owner,defending?f.owner:f.enemy,0,0);
test('five explicit Wait descriptions bind six distinct original Purple variants',()=>{
 assert.equal(rules.reduce((n,r)=>n+coverage.entries.find(e=>e.key==='skill:'+r.id).variants.length,0),6);
 const literal={1471:'The battle opponent becomes paralyzed. The battle opponent gains Wait 3.',1524:'The battle opponent and opposing Pokémon adjacent to it become burned. Those Pokémon gain Wait 3.',1532:'The battle opponent, and a succession of opposing Pokémon adjacent to it, gain Wait 3.',1566:'The battle opponent gains Wait 3.',1598:'The battle opponent becomes poisoned. The battle opponent gains Wait 7.'};
 for(const r of rules){const entry=coverage.entries.find(e=>e.key==='skill:'+r.id);assert(entry.evidence.some(row=>row.text===literal[r.id]));assert(entry.variants.every(v=>v.color===2));}
});
for(const rule of rules)for(const owner of [0,6]){
 test(`${owner}: Purple Wait${rule.id} every variant, role and prior condition`,()=>{
  const entry=coverage.entries.find(e=>e.key==='skill:'+rule.id);
  for(const v of entry.variants)for(const defending of [false,true])for(const prior of ['normal','poison','burn','freeze']){
   const f=fixture(owner,rule.id);f.figure(owner).id=v.occurrences[0].figure_id;f.figure(owner).skills=[attack(rule.id,2,v.stars,v.range),attack(1131,0,0,96-v.range)];
   f.match.turn=(defending?f.enemy:owner)===0?'black':'white';f.match.conditions.set(f.enemy,prior);f.match.waits.set(f.enemy,1);
   const before=[...f.match.positions],r=resolve(f,defending);assert.equal(r.winner,owner);assert.deepEqual(r.purpleWaitPlan.targets,[f.enemy]);assert.equal(f.match.waits.get(f.enemy),rule.wait);
   assert.equal(f.match.conditions.get(f.enemy),rule.condition??prior);assert.equal(f.match.waits.get(owner),0);assert.deepEqual([...f.match.positions],before);assert.equal(r.knockout,false);assert.deepEqual(r.pendingKnockoutTargets??[],[]);
  }
 });
 test(`${owner}: Purple Wait${rule.id} comparison failures do not grant Wait or conditions`,()=>{
  for(const color of [2,3,4])for(const value of color===2?[3,4]:[50]){
   const f=fixture(owner,rule.id);f.figure(f.enemy).skills=[attack(color===4?1122:1009,color,value)];f.match.conditions.set(f.enemy,'poison');f.match.waits.set(f.enemy,1);
   const r=resolve(f);assert.equal(r.purpleWaitPlan,undefined);assert.equal(f.match.waits.get(f.enemy),1);assert.equal(f.match.conditions.get(f.enemy),'poison');
  }
 });
 test(`${owner}: Purple Wait${rule.id} exact opposing adjacency and connected group`,()=>{
  const f=fixture(owner,rule.id);chain(f);for(let n=0;n<6;n++)f.match.conditions.set(f.enemy+n,'poison');
  const before=[...f.match.positions],r=resolve(f),wanted=rule.id===1532?Array.from({length:6},(_,i)=>f.enemy+i):rule.id===1524?[f.enemy,f.enemy+1]:[f.enemy];
  assert.deepEqual(r.purpleWaitPlan.targets,wanted);assert.deepEqual([...f.match.positions],before);assert.equal(new Set(f.match.positions.values()).size,12);
  for(let n=0;n<12;n++){assert.equal(f.match.waits.get(n),wanted.includes(n)?rule.wait:0);assert.equal(f.match.conditions.get(n),wanted.includes(n)&&rule.condition?rule.condition:n>=f.enemy&&n<f.enemy+6?'poison':'normal');}
 });
}
for(const owner of [0,6])for(const id of [1471,1524,1598])test(`${owner}: ${id} condition immunity leaves its independent Wait intact`,()=>{
 for(const prior of ['normal','sleep'])for(const ability of [1226,1077]){
  const f=fixture(owner,id),rule=rules.find(r=>r.id===id);f.figure(f.enemy).pokepower=ability;f.match.conditions.set(f.enemy,prior);
  const r=resolve(f),immune=ability===1226;assert.deepEqual(r.purpleWaitPlan.condition_targets,immune?[]:[f.enemy]);
  assert.equal(f.match.conditions.get(f.enemy),immune?prior:rule.condition);assert.equal(f.match.waits.get(f.enemy),rule.wait);
 }
});
for(const owner of [0,6])test(`${owner}: Flash Over per-target self/type/team/adjacent protection`,()=>{
 for(const ability of [1149,1151,1383,1427,1485])for(const sourceOnField of [false,true]){
  const f=fixture(owner,1524);chain(f);const holder=ability===1149?f.enemy:f.enemy+2;f.figure(holder).pokepower=ability;
  f.figure(f.enemy).id=1002;f.figure(f.enemy+1).id=1022;
  if(ability!==1149)f.match.positions.set(holder,sourceOnField?(f.enemy===6?10:27):28+holder);
  else if(!sourceOnField)f.figure(holder).pokepower=-1;
  const r=resolve(f);const protectedTarget=sourceOnField&&[1149,1151,1383,1427].includes(ability),protectedNeighbor=sourceOnField&&[1383,1427,1485].includes(ability);
  assert.equal(f.match.conditions.get(f.enemy),protectedTarget?'normal':'burn');assert.equal(f.match.conditions.get(f.enemy+1),protectedNeighbor?'normal':'burn');
  assert.equal(f.match.waits.get(f.enemy),3);assert.equal(f.match.waits.get(f.enemy+1),3);assert.deepEqual(r.purpleWaitPlan.wait_targets,[f.enemy,f.enemy+1]);
 }
});
for(const owner of [0,6])test(`${owner}: Contagious Terror stops at gaps, allies, bench and Center`,()=>{
 for(const point of [28+(owner===0?7:1),40,41,42,43]){
  const f=fixture(owner,1532);chain(f);f.match.positions.set(f.enemy+1,point);const p=plan(f.match.record,f.match.positions,owner,f.enemy,attack(1532),contract.fieldEdges);assert.deepEqual(p.targets,[f.enemy]);
 }
 const f=fixture(owner,1532);chain(f);const former=f.match.positions.get(f.enemy+1);f.match.positions.set(f.enemy+1,28+f.enemy+1);f.match.positions.set(owner+1,former);
 assert.deepEqual(resolve(f).purpleWaitPlan.targets,[f.enemy],'an allied bridge does not propagate opposing-only Wait');
 f.match.positions=new Map([...f.match.positions].reverse());assert.deepEqual(plan(f.match.record,f.match.positions,owner,f.enemy,attack(1532),contract.fieldEdges).targets,[f.enemy]);
});
test('Purple Wait plan rejects off-field, missing, same-team and unknown participants without mutation',()=>{
 for(const rule of rules){const f=fixture(0,rule.id);for(const invalid of [-1,12,500])assert.equal(plan(f.match.record,f.match.positions,0,invalid,attack(rule.id),contract.fieldEdges),null);
  for(const point of [-1,28,40,43]){const points=new Map(f.match.positions);points.set(6,point);assert.equal(plan(f.match.record,points,0,6,attack(rule.id),contract.fieldEdges),null);}
  f.match.positions.set(1,11);assert.equal(plan(f.match.record,f.match.positions,0,1,attack(rule.id),contract.fieldEdges),null);
  assert.equal(plan(f.match.record,f.match.positions,0,6,attack(rule.id,0),contract.fieldEdges),null);assert.equal(plan(f.match.record,f.match.positions,0,6,attack(99999),contract.fieldEdges),null);
  f.match.record.players[1].pokemons=f.match.record.players[1].pokemons.filter(p=>p.pokemon_index!==6);assert.equal(plan(f.match.record,f.match.positions,0,6,attack(rule.id),contract.fieldEdges),null);
 }
});
