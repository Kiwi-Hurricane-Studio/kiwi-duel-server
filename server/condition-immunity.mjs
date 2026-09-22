import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';

const data=JSON.parse(readFileSync(new URL('../data/condition_immunity_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-condition-immunity-rules-v1')throw new Error('invalid_condition_immunity_rules');
const rules=new Map(data.rules.map(rule=>[rule.ability,rule]));
const onField=point=>Number.isInteger(point)&&point>=0&&point<28;
const lookup=(values,index)=>values instanceof Map?values.get(index):values?.[index];

// Only the new application is prevented. This does not cure an old condition,
// prevent a damage/effect KO, alter Wait, or certify unrelated ability clauses.
export function conditionImmunitySources(record,positions,target,condition,fieldEdges) {
  if(!Number.isInteger(target)||target<0||target>=12||!onField(lookup(positions,target)))return [];
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]);
  const targetFigure=figures.find(pokemon=>Number(pokemon.pokemon_index)===target);
  if(!targetFigure)return [];
  const result=[];
  for(const source of figures) {
    const owner=Number(source.pokemon_index),rule=rules.get(Number(source.pokepower));
    if(!rule||!rule.conditions.includes(condition)||!onField(lookup(positions,owner)))continue;
    if(rule.scope==='self'&&owner!==target)continue;
    if(rule.scope!=='self'&&Math.floor(owner/6)!==Math.floor(target/6))continue;
    if(rule.scope==='adjacent_team') {
      const from=lookup(positions,owner),to=lookup(positions,target);
      if(!fieldEdges.some(([a,b])=>(a===from&&b===to)||(a===to&&b===from)))continue;
    }
    if(rule.types) {
      const resolved=resolveRecordFigure(Number(targetFigure.id));
      if(!resolved.ok||!rule.types.some(type=>[resolved.rule.type0,resolved.rule.type1].includes(type)))continue;
    }
    result.push({pokemon:owner,pokepower:rule.ability});
  }
  return result.sort((a,b)=>a.pokemon-b.pokemon);
}
