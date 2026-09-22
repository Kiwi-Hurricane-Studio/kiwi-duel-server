import {readFileSync} from 'node:fs';
import {conditionImmunitySources} from './condition-immunity.mjs';
import {spherePreventionPlate} from './sphere-plates.mjs';
const data=JSON.parse(readFileSync(new URL('../data/purple_condition_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-purple-condition-rules-v1')throw new Error('invalid_purple_condition_rules');
const rules=new Map(data.attacks.map(rule=>[rule.skill,rule]));
const onField=(points,p)=>Number.isSafeInteger(p)&&p>=0&&p<12&&Number.isSafeInteger(points.get(p))&&points.get(p)>=0&&points.get(p)<28;

export function purpleConditionPlan(record,points,emitter,opponent,skill,edges,plateState=null){
  const rule=rules.get(Number(skill?.id));
  if(!rule||Number(skill?.color)!==2||!onField(points,emitter)||!onField(points,opponent)||Math.floor(emitter/6)===Math.floor(opponent/6))return null;
  const ids=new Set((record?.players??[]).flatMap(player=>player.pokemons??[]).map(figure=>Number(figure.pokemon_index)));
  if(!ids.has(emitter)||!ids.has(opponent))return null;
  const figures=[...ids].filter(p=>onField(points,p));
  const adjacent=(a,b)=>edges.some(([x,y])=>x===points.get(a)&&y===points.get(b)||y===points.get(a)&&x===points.get(b));
  let selected=[];
  switch(rule.target){
    case 'emitter':selected=[emitter];break;
    case 'opponent':selected=[opponent];break;
    case 'emitter_and_opponent':selected=[emitter,opponent];break;
    case 'adjacent_to_emitter_all_sides':selected=figures.filter(p=>p!==emitter&&adjacent(emitter,p));break;
    case 'emitter_and_adjacent_all_sides':selected=figures.filter(p=>p===emitter||adjacent(emitter,p));break;
    case 'opponent_and_adjacent_opponents':selected=figures.filter(p=>Math.floor(p/6)===Math.floor(opponent/6)&&(p===opponent||adjacent(opponent,p)));break;
    case 'connected_from_opponent_all_sides':
    case 'connected_from_opponent_excluding_emitter':{
      const eligible=figures.filter(p=>rule.target==='connected_from_opponent_all_sides'||p!==emitter);
      const component=new Set([opponent]),frontier=[opponent];
      for(let cursor=0;cursor<frontier.length;cursor++)for(const p of eligible)if(!component.has(p)&&adjacent(frontier[cursor],p)){component.add(p);frontier.push(p);}
      selected=[...component];break;
    }
    default:throw new Error('unsupported_purple_condition_target');
  }
  // Original1769 puts the losing opponent before its winning emitter, in either battle role.
  const targets=Number(skill.id)===1769?[opponent,emitter]:selected.sort(Number(skill.id)===1055?(a,b)=>points.get(a)-points.get(b):(a,b)=>a-b);
  // Select the complete component and every immunity source before writing any
  // condition. A prevented status does not silently remove a graph intermediary.
  const transfers=targets.map(p=>({pokemon:p,blocked_by:conditionImmunitySources(record,points,p,rule.condition,edges)}));
  const sphere_blocked=targets.filter(p=>spherePreventionPlate(record,points,plateState,p,rule.condition,edges)>=0);
  return {skill:rule.skill,emitter,condition:rule.condition,scope:rule.target,targets,condition_targets:transfers.filter(t=>!t.blocked_by.length&&!sphere_blocked.includes(t.pokemon)).map(t=>t.pokemon),transfers,sphere_blocked};
}
