import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/purple_star_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-purple-star-rules-v1')throw new Error('invalid_purple_star_rules');
const rules=new Map(data.rules.map(rule=>[rule.ability,rule]));
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;

export function purpleStarSources(record,positions,battled,pokemon,skill,actingSide) {
  if(Number(skill?.color)!==2||skill.z_skill||skill.disabled_replacement||!field(positions.get(pokemon)))return [];
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]),target=figures.find(f=>Number(f.pokemon_index)===pokemon);
  const resolved=resolveRecordFigure(Number(target?.id));
  if(!resolved.ok)return [];
  const types=[resolved.rule.type0,resolved.rule.type1],sources=[],counted=new Set();
  for(const figure of [...figures].sort((a,b)=>Number(a.pokemon_index)-Number(b.pokemon_index))) {
    const source=Number(figure.pokemon_index),rule=rules.get(Number(figure.pokepower));
    if(!rule||!field(positions.get(source))||Math.floor(source/6)!==Math.floor(pokemon/6))continue;
    if(rule.target==='self'&&source!==pokemon)continue;
    if(rule.target==='allied_type'&&!types.includes(rule.type))continue;
    if(rule.owner_turn_only&&(source<6?'black':'white')!==actingSide)continue;
    if(rule.first_battle&&battled.get(source))continue;
    if(rule.noncumulative&&counted.has(rule.ability))continue;
    counted.add(rule.ability);
    sources.push({source,pokepower:rule.ability,bonus:rule.bonus});
  }
  return sources;
}

export function applyPurpleStars(record,positions,battled,pokemon,skill,actingSide) {
  const sources=purpleStarSources(record,positions,battled,pokemon,skill,actingSide);
  if(!sources.length)return skill;
  // These source annotations stay local to result calculation. The original
  // native announcement sequence is not established by the numeric contract.
  skill.purple_star_sources=sources;
  skill.purple_star_bonus=sources.reduce((sum,source)=>sum+source.bonus,0);
  skill.speed_or_damage+=skill.purple_star_bonus;
  return skill;
}
