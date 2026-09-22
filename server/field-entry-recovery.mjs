import {readFileSync} from 'node:fs';
const rules=JSON.parse(readFileSync(new URL('../data/field_entry_recovery_rules.json',import.meta.url))).rules;
const conditions=new Set(['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']);
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;
// Original ARM controls recover allied field figures. The earlier broad
// reading of "your Pokemon" is retained as a conflict in the native contract.

export function fieldEntryRecoveryPlan(record,before,after,currentConditions,currentWaits,currentTriangles=new Map()){
 const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]).filter(f=>Number.isSafeInteger(f.pokemon_index)&&f.pokemon_index>=0&&f.pokemon_index<12).sort((a,b)=>a.pokemon_index-b.pokemon_index);
 const result=[];
 for(const figure of figures){
  const source=figure.pokemon_index,rule=rules.find(r=>r.ability===Number(figure.pokepower));
  const origin=before.get(source);
  if(!rule||!Number.isSafeInteger(origin)||origin<28||origin>=40||Math.floor((origin-28)/6)!==Math.floor(source/6)||!field(after.get(source)))continue;
  const allies=figures.filter(f=>Math.floor(f.pokemon_index/6)===Math.floor(source/6)&&field(after.get(f.pokemon_index))).map(f=>f.pokemon_index);
  const condition_targets=allies.filter(p=>rule.remove_special_conditions&&conditions.has(currentConditions.get(p))||(rule.remove_conditions??[]).includes(currentConditions.get(p)));
  const wait_targets=rule.remove_wait?allies.filter(p=>Number(currentWaits.get(p))>0):[];
  const triangle_targets=rule.remove_curse?allies.filter(p=>currentTriangles.get(p)==='curse'):[];
  if(condition_targets.length||wait_targets.length||triangle_targets.length)result.push({source,ability:rule.ability,condition_targets,wait_targets,...(triangle_targets.length?{triangle_targets}: {})});
 }
 return result;
}

export function applyFieldEntryRecovery(match,plan){
 for(const recovery of plan){
  for(const pokemon of recovery.condition_targets){match.conditions.set(pokemon,'normal');match.disabledSkills?.delete(pokemon);}
  for(const pokemon of recovery.wait_targets)match.waits.set(pokemon,0);
  for(const pokemon of recovery.triangle_targets??[])match.triangles.set(pokemon,'empty');
 }
}
