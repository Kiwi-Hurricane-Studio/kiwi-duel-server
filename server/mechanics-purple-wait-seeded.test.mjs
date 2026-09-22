import test from 'node:test';
import assert from 'node:assert/strict';
import {CustomMatchService,customMatchContract as contract} from './custom-match-engine.mjs';

const rules=[{id:1471,condition:'paralyze',wait:3},{id:1524,condition:'burn',wait:3},{id:1532,wait:3},{id:1566,wait:3},{id:1598,condition:'poison',wait:7}];
const conditions=['normal','poison','bad_poison','burn','paralyze','panic','sleep','freeze','melt'];
const attack=(id,color,power)=>({id,color,speed_or_damage:power,range:96});
function generator(seed){let state=seed>>>0;return maximum=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*maximum);};}
function shuffled(values,random){const result=[...values];for(let i=result.length-1;i>0;i--){const j=random(i+1);[result[i],result[j]]=[result[j],result[i]];}return result;}

for(const rule of rules)for(const owner of [0,6])test(`${owner}: seeded Purple Wait${rule.id} 128 real engine outcomes preserve target boundaries and non-target state`,()=>{
 const seed=0x51a70000+rule.id*17+owner,random=generator(seed),enemy=owner===0?6:0;
 const service=new CustomMatchService({port:0,clockSource:()=>0});
 let multiTargetOutcomes=0;
 for(let scenario=0;scenario<128;scenario++){
  const label=`seed ${seed}, scenario ${scenario}`,match=service.createMatch('purple-wait-seeded-isolated');
  const edge=contract.fieldEdges[random(contract.fieldEdges.length)];
  match.positions.set(owner,edge[0]);match.positions.set(enemy,edge[1]);
  const unused=shuffled(Array.from({length:28},(_,i)=>i).filter(p=>!edge.includes(p)),random);
  for(let p=0;p<12;p++)if(p!==owner&&p!==enemy)match.positions.set(p,random(4)===0?28+p:unused.pop());
  const immune=new Set();
  for(const player of match.record.players)for(const figure of player.pokemons){
   const p=figure.pokemon_index;figure.id=1005;figure.pokepower=-1;figure.skills=[attack(1199,1,50)];
   match.conditions.set(p,p===owner?'normal':conditions[random(conditions.length)]);match.waits.set(p,p===owner?0:random(3));
   if(p!==owner&&random(4)===0){figure.id=1092;figure.pokepower=1226;immune.add(p);}
   if(p===owner)figure.skills=[attack(rule.id,2,3)];
  }
  const before={positions:new Map(match.positions),conditions:new Map(match.conditions),waits:new Map(match.waits)};
  const figures=Array.from({length:6},(_,i)=>enemy+i).filter(p=>match.positions.get(p)<28);
  const adjacent=(a,b)=>contract.fieldEdges.some(edge=>edge.includes(before.positions.get(a))&&edge.includes(before.positions.get(b)));
  let targets=[enemy];
  if(rule.id===1524)targets=figures.filter(p=>p===enemy||adjacent(enemy,p));
  if(rule.id===1532){
   // Independent transitive-closure oracle over the induced opposing graph.
   // Runtime uses frontier traversal; this checks arbitrary cycles and gaps.
   const connected=figures.map(a=>figures.map(b=>a===b||adjacent(a,b)));
   for(let k=0;k<figures.length;k++)for(let i=0;i<figures.length;i++)for(let j=0;j<figures.length;j++)connected[i][j] ||= connected[i][k]&&connected[k][j];
   targets=figures.filter((p,i)=>connected[figures.indexOf(enemy)][i]);
  }
  targets.sort((a,b)=>a-b);if(targets.length>1)multiTargetOutcomes++;
  // Stable outcomes must not depend on record/map enumeration or attack role.
  match.positions=new Map(shuffled([...match.positions],random));
  const defending=random(2)===1;match.turn=(defending?enemy:owner)===0?'black':'white';
  const result=service.applyBaseBattleOutcome(match,defending?enemy:owner,defending?owner:enemy,0,0);
  assert.equal(result.winner,owner,label);assert.deepEqual(result.purpleWaitPlan.targets,targets,label);
  assert.deepEqual(result.purpleWaitPlan.condition_targets,rule.condition?targets.filter(p=>!immune.has(p)):[],label);
  assert.equal(result.knockout,false,label);assert.equal(new Set(match.positions.values()).size,12,label);
  for(let p=0;p<12;p++){
   assert.equal(match.positions.get(p),before.positions.get(p),label+' position '+p);
   assert.equal(match.waits.get(p),targets.includes(p)?rule.wait:before.waits.get(p),label+' Wait '+p);
   assert.equal(match.conditions.get(p),targets.includes(p)&&rule.condition&&!immune.has(p)?rule.condition:before.conditions.get(p),label+' condition '+p);
  }
 }
 if([1524,1532].includes(rule.id))assert(multiTargetOutcomes>=20,'seeded group coverage must include at least20 multi-target outcomes');
});
