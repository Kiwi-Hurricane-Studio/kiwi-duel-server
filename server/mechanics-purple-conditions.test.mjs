import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract as contract,customMatchTestHooks as hooks} from './custom-match-engine.mjs';
import {purpleConditionPlan as plan} from './purple-conditions.mjs';
const coverage=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const rules=[{id:1035,condition:'sleep'},{id:1041,condition:'paralyze'},{id:1055,condition:'poison'},{id:1086,condition:'sleep'},{id:1099,condition:'panic'},{id:1100,condition:'panic'},{id:1145,condition:'paralyze'},{id:1233,condition:'burn'},{id:1546,condition:'panic'},{id:1548,condition:'paralyze'},{id:1764,condition:'sleep'},{id:1769,condition:'paralyze'}];
const allConditions=['normal','panic','sleep','burn','paralyze','poison','bad_poison','freeze','melt'];
const blockers={sleep:1077,panic:1066,burn:1149,poison:1075,paralyze:1001};
const attack=(id,color=2,power=3,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,id){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('purple-condition-isolated'),enemy=owner===0?6:0;
 const figure=p=>match.record.players.flatMap(row=>row.pokemons).find(f=>f.pokemon_index===p);
 for(const player of match.record.players)for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.skills=[attack(1199,1,50)];}
 figure(owner).skills=[attack(id)];match.positions.set(0,15);match.positions.set(6,11);match.turn=owner===0?'black':'white';
 return {service,match,figure,owner,enemy};
}
function group(f){for(const start of [0,6]){const points=start===0?[15,20,27,19,18,25]:[11,6,5,10,9,2];for(let n=0;n<6;n++)f.match.positions.set(start+n,points[n]);}}
const resolve=(f,defending=false)=>{f.match.turn=(defending?f.enemy:f.owner)===0?'black':'white';return f.service.applyBaseBattleOutcome(f.match,defending?f.enemy:f.owner,defending?f.owner:f.enemy,0,0);};
const pairTargets=(id,owner,enemy)=>id===1086?[owner]:id===1769?[enemy,owner]:[1041,1145].includes(id)?[owner,enemy].sort((a,b)=>a-b):[enemy];
const groupTargets=(id,owner,enemy)=>id===1086?[owner]:[1099,1764].includes(id)?[enemy]:id===1769?[enemy,owner]:id===1145?Array.from({length:12},(_,i)=>i):id===1548?Array.from({length:6},(_,i)=>enemy+i):id===1546?[enemy,enemy+1]:[...(id===1041?[owner]:[]),owner+1,enemy].sort((a,b)=>a-b);

test('twelve new Purple condition IDs bind fourteen exact original variants; Mass Hypnosis remains unadmitted',()=>{
 let variants=0;for(const r of rules){const entry=coverage.entries.find(e=>e.key==='skill:'+r.id);assert(entry.evidence.length>0);assert(entry.variants.every(v=>v.color===2));variants+=entry.variants.length;}
 assert.equal(variants,14);const f=fixture(0,1534);assert.equal(plan(f.match.record,f.match.positions,0,6,attack(1534),contract.fieldEdges),null);
});
for(const rule of rules)for(const owner of [0,6]){
 test(`${owner}: Purple condition${rule.id} all variants, roles, prior conditions and independent Wait`,()=>{
  const entry=coverage.entries.find(e=>e.key==='skill:'+rule.id);
  for(const v of entry.variants)for(const defending of [false,true])for(const prior of allConditions){
   const f=fixture(owner,rule.id);f.figure(owner).id=v.occurrences[0].figure_id;f.figure(owner).skills=[attack(rule.id,2,v.stars,v.range),attack(1131,0,0,96-v.range)];
   f.match.conditions.set(f.enemy,prior);f.match.waits.set(owner,2);f.match.waits.set(f.enemy,1);
   const before=new Map(f.match.positions),wanted=pairTargets(rule.id,owner,f.enemy),result=resolve(f,defending);
   assert.equal(result.winner,owner);assert.deepEqual(result.purpleConditionPlan.targets,wanted);assert.equal(result.knockout,false);assert.deepEqual(result.pendingKnockoutTargets??[],[]);
   for(let p=0;p<12;p++){assert.equal(f.match.positions.get(p),before.get(p));assert.equal(f.match.conditions.get(p),wanted.includes(p)?rule.condition:p===f.enemy?prior:'normal');assert.equal(f.match.waits.get(p),p===owner?2:p===f.enemy?1:0);}
  }
 });
 test(`${owner}: Purple condition${rule.id} ties, stronger Purple, Gold, Blue and disabled source do not apply`,()=>{
  for(const [color,power]of [[2,3],[2,4],[3,50],[4,0]]){
   const f=fixture(owner,rule.id);f.figure(f.enemy).skills=[attack(color===4?1122:1009,color,power)];const result=resolve(f);
   assert.equal(result.purpleConditionPlan,undefined);assert.equal(f.match.conditions.get(f.enemy),'normal');assert.equal(f.match.waits.get(f.enemy),0);
  }
  const f=fixture(owner,rule.id);f.match.conditions.set(owner,'freeze');f.match.disabledSkills.set(owner,new Set(hooks.conditionDisabledSkills(f.match,owner)));assert.equal(resolve(f).purpleConditionPlan,undefined);
 });
 test(`${owner}: Purple condition${rule.id} exact mixed-team group and independent immunity snapshot`,()=>{
  for(const mode of ['plain','immune-bridge','team-aura','aura-bench']){
   const f=fixture(owner,rule.id);group(f);const wanted=groupTargets(rule.id,owner,f.enemy),immune=mode==='immune-bridge'?f.enemy+1:-1;
   const holder=f.enemy+5;
   if(immune>=0)f.figure(immune).pokepower=blockers[rule.condition];
   if(mode==='team-aura'||mode==='aura-bench'){f.figure(holder).pokepower=1427;if(mode==='aura-bench')f.match.positions.set(holder,28+holder);}
   const selected=mode==='aura-bench'?wanted.filter(p=>p!==holder):wanted;
   if(rule.id===1055)selected.sort((a,b)=>f.match.positions.get(a)-f.match.positions.get(b)); // Original adjacent-poison histories: board-point order.
   const allowed=selected.filter(p=>p!==immune&&(mode!=='team-aura'||Math.floor(p/6)!==Math.floor(f.enemy/6)));
   const result=resolve(f);assert.deepEqual(result.purpleConditionPlan.targets,selected);assert.deepEqual(result.purpleConditionPlan.condition_targets,allowed);
   for(let p=0;p<12;p++)assert.equal(f.match.conditions.get(p),allowed.includes(p)?rule.condition:'normal');
   const reverse=structuredClone(f.match.record);reverse.players.reverse();for(const player of reverse.players)player.pokemons.reverse();
   assert.deepEqual(plan(reverse,new Map([...f.match.positions].reverse()),owner,f.enemy,attack(rule.id),contract.fieldEdges),result.purpleConditionPlan);
  }
 });
 test(`${owner}: seeded Purple condition${rule.id} 64 real outcomes preserve the selected spatial scope`,()=>{
  let state=(0x37a10000+owner+rule.id*19)>>>0;const random=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*max);};
  for(let n=0;n<64;n++){
   const f=fixture(owner,rule.id),edge=contract.fieldEdges[random(contract.fieldEdges.length)];f.match.positions.set(owner,edge[0]);f.match.positions.set(f.enemy,edge[1]);
   const available=Array.from({length:28},(_,i)=>i).filter(p=>!edge.includes(p));
   for(let p=0;p<12;p++)if(p!==owner&&p!==f.enemy){const index=random(available.length);f.match.positions.set(p,random(4)===0?28+p:available.splice(index,1)[0]);}
   const prior=new Map();for(let p=0;p<12;p++){prior.set(p,p===owner?'normal':allConditions[random(allConditions.length)]);f.match.conditions.set(p,prior.get(p));f.match.waits.set(p,random(5));}
   const before={points:new Map(f.match.positions),waits:new Map(f.match.waits)};
   const field=[...f.match.positions].filter(([,point])=>point<28).map(([p])=>p),adjacent=(a,b)=>contract.fieldEdges.some(edge=>edge.includes(before.points.get(a))&&edge.includes(before.points.get(b)));
   let selected;
   if(rule.id===1086)selected=[owner];else if([1099,1764].includes(rule.id))selected=[f.enemy];else if(rule.id===1769)selected=[f.enemy,owner];
   else if(rule.id===1546)selected=field.filter(p=>Math.floor(p/6)===Math.floor(f.enemy/6)&&(p===f.enemy||adjacent(f.enemy,p)));
   else if([1145,1548].includes(rule.id)){
    const vertices=field.filter(p=>rule.id!==1548||p!==owner),reach=vertices.map(a=>vertices.map(b=>a===b||adjacent(a,b)));
    for(let k=0;k<vertices.length;k++)for(let i=0;i<vertices.length;i++)for(let j=0;j<vertices.length;j++)reach[i][j] ||= reach[i][k]&&reach[k][j];
    selected=vertices.filter((p,i)=>reach[vertices.indexOf(f.enemy)][i]);
   }else selected=field.filter(p=>(rule.id===1041&&p===owner)||(p!==owner&&adjacent(owner,p)));
   if(rule.id!==1769)selected.sort(rule.id===1055?(a,b)=>before.points.get(a)-before.points.get(b):(a,b)=>a-b);const result=resolve(f,random(2)===1);assert.deepEqual(result.purpleConditionPlan.targets,selected,`seeded case${n}`);assert.equal(new Set(f.match.positions.values()).size,12);
   for(let p=0;p<12;p++){assert.equal(f.match.conditions.get(p),selected.includes(p)?rule.condition:prior.get(p));assert.equal(f.match.positions.get(p),before.points.get(p));assert.equal(f.match.waits.get(p),before.waits.get(p));}
  }
 });
}
test('connected conditions distinguish emitter exclusion, friendly bridges, gaps and invalid/off-field participants',()=>{
 for(const owner of [0,6])for(const id of [1145,1548]){
  const f=fixture(owner,id);group(f);f.match.positions.set(f.enemy+1,28+f.enemy+1);
  assert.deepEqual(plan(f.match.record,f.match.positions,owner,f.enemy,attack(id),contract.fieldEdges).targets,id===1145?[...Array.from({length:6},(_,i)=>owner+i),f.enemy].sort((a,b)=>a-b):[f.enemy]);
  f.match.positions.set(owner+1,f.enemy===6?6:20);f.match.positions.set(owner+2,28+owner+2);f.match.positions.set(owner+3,28+owner+3);f.match.positions.set(owner+4,28+owner+4);f.match.positions.set(owner+5,28+owner+5);
  const wanted=[...Array.from({length:6},(_,i)=>f.enemy+i).filter(p=>p!==f.enemy+1),owner+1,...(id===1145?[owner]:[])].sort((a,b)=>a-b);
  assert.deepEqual(plan(f.match.record,f.match.positions,owner,f.enemy,attack(id),contract.fieldEdges).targets,wanted,'friendly intermediary carries the all-side component');
 }
 for(const rule of rules){const f=fixture(0,rule.id);for(const target of [-1,12,100])assert.equal(plan(f.match.record,f.match.positions,0,target,attack(rule.id),contract.fieldEdges),null);
  for(const point of [-1,28,40,41,42,43]){const points=new Map(f.match.positions);points.set(6,point);assert.equal(plan(f.match.record,points,0,6,attack(rule.id),contract.fieldEdges),null);}
  f.match.positions.set(1,11);assert.equal(plan(f.match.record,f.match.positions,0,1,attack(rule.id),contract.fieldEdges),null);assert.equal(plan(f.match.record,f.match.positions,0,6,attack(rule.id,0),contract.fieldEdges),null);
  f.match.record.players[1].pokemons=f.match.record.players[1].pokemons.filter(p=>p.pokemon_index!==6);assert.equal(plan(f.match.record,f.match.positions,0,6,attack(rule.id),contract.fieldEdges),null);
 }
});
