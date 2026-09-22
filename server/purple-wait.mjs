import {waitTargets} from './wait-immunity.mjs';
import {readFileSync} from 'node:fs';
import {conditionImmunitySources} from './condition-immunity.mjs';
const data=JSON.parse(readFileSync(new URL('../data/purple_wait_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-purple-wait-rules-v1')throw new Error('invalid_purple_wait_rules');
const attacks=new Map(data.attacks.map(rule=>[rule.skill,rule]));
const field=(points,pokemon)=>Number.isSafeInteger(pokemon)&&pokemon>=0&&pokemon<12&&Number.isSafeInteger(points.get(pokemon))&&points.get(pokemon)>=0&&points.get(pokemon)<28;

export function purpleWaitPlan(record,points,emitter,opponent,skill,edges){
  const rule=attacks.get(Number(skill?.id));
  if(!rule||Number(skill?.color)!==2||!field(points,emitter)||!field(points,opponent)||Math.floor(emitter/6)===Math.floor(opponent/6))return null;
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]);
  const ids=new Set(figures.map(figure=>Number(figure.pokemon_index)));
  if(!ids.has(emitter)||!ids.has(opponent))return null;
  const opponents=[...ids].filter(pokemon=>field(points,pokemon)&&Math.floor(pokemon/6)===Math.floor(opponent/6));
  const adjacent=(a,b)=>edges.some(([left,right])=>left===points.get(a)&&right===points.get(b)||right===points.get(a)&&left===points.get(b));
  const selected=new Set([opponent]);
  if(rule.target==='opponent_and_adjacent_opponents')for(const pokemon of opponents)if(adjacent(opponent,pokemon))selected.add(pokemon);
  if(rule.target==='opposing_connected_component'){
    const frontier=[opponent];
    for(let index=0;index<frontier.length;index++)for(const pokemon of opponents){
      if(!selected.has(pokemon)&&adjacent(frontier[index],pokemon)){selected.add(pokemon);frontier.push(pokemon);}
    }
  }
  const targets=[...selected].sort((a,b)=>a-b),transfers=rule.condition?targets.map(pokemon=>({pokemon,blocked_by:conditionImmunitySources(record,points,pokemon,rule.condition,edges)})):[];
  return {skill:rule.skill,emitter,targets,wait:rule.wait,wait_targets:waitTargets(record,targets),condition:rule.condition??null,
    condition_targets:transfers.filter(row=>row.blocked_by.length===0).map(row=>row.pokemon),transfers};
}
