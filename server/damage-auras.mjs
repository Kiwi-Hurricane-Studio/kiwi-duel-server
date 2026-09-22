import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/damage_aura_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-damage-aura-rules-v1')throw new Error('invalid_damage_aura_rules');
const rules=new Map(data.rules.map(rule=>[rule.ability,rule]));
const fieldCountRules=new Map(data.self_field_count_rules.map(rule=>[rule.ability,rule]));
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;

export function damageAuraSources(record,positions,conditions,pokemon,skill) {
  if(![1,3].includes(Number(skill?.color))||!field(positions.get(pokemon)))return [];
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]),target=figures.find(f=>Number(f.pokemon_index)===pokemon);
  const resolved=resolveRecordFigure(Number(target?.id));
  if(!resolved.ok)return [];
  const types=[resolved.rule.type0,resolved.rule.type1],result=[];
  for(const figure of figures) {
    const source=Number(figure.pokemon_index),rule=rules.get(Number(figure.pokepower));
    if(!rule||(!field(positions.get(source))&&!(rule.allows_bench_source&&positions.get(source)===28+source))||Math.floor(source/6)!==Math.floor(pokemon/6))continue;
    const matchingTypes=(rule.types??[rule.type]).filter(type=>types.includes(type));
    if(!matchingTypes.length)continue;
    if(rule.requires_healthy_source&&data.special_conditions.includes(conditions.get(source)??'normal'))continue;
    result.push({source,pokepower:rule.ability,addend:rule.bonus*(rule.per_matching_type?matchingTypes.length:1)});
  }
  return result.sort((a,b)=>a.source-b.source);
}

export function applyDamageAuras(record,positions,conditions,pokemon,skill,plateBonus=Number(skill?.x_attack_bonus??0)) {
  const sources=damageAuraSources(record,positions,conditions,pokemon,skill);
  if(!sources.length)return skill;
  // Treat "+N damage" as an additive term for the resolved attack, consistent
  // with the existing flat plate bonus. Compound native ordering is unverified.
  let current=Number(skill.speed_or_damage)-plateBonus;
  skill.damage_aura_changes=sources.map(source=>{
    const change={...source,current,result:current+source.addend};current=change.result;return change;
  });
  skill.damage_aura_bonus=sources.reduce((sum,source)=>sum+source.addend,0);
  skill.speed_or_damage+=skill.damage_aura_bonus;
  return skill;
}

export function applyFieldCountDamage(record,positions,pokemon,skill,plateBonus=0) {
  if(![1,3].includes(Number(skill?.color))||!field(positions.get(pokemon)))return skill;
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]),target=figures.find(f=>Number(f.pokemon_index)===pokemon);
  const rule=fieldCountRules.get(Number(target?.pokepower));
  if(!rule||!resolveRecordFigure(Number(target?.id)).ok)return skill;
  const counted=figures.filter(figure=>{
    if(!field(positions.get(Number(figure.pokemon_index))))return false;
    const resolved=resolveRecordFigure(Number(figure.id));
    return resolved.ok&&[resolved.rule.type0,resolved.rule.type1].includes(rule.type);
  }).map(figure=>Number(figure.pokemon_index)).sort((a,b)=>a-b);
  if(!counted.length)return skill;
  const current=Number(skill.speed_or_damage)-plateBonus,bonus=counted.length*rule.per_figure;
  skill.field_count_damage_bonus=bonus;
  skill.field_count_damage_change={source:pokemon,pokepower:rule.ability,counted,current,multiplier:counted.length,multiplicand:rule.per_figure,result:current+bonus};
  skill.speed_or_damage+=bonus;
  return skill;
}
