import {waitTargets} from './wait-immunity.mjs';
import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/effect_knockout_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-effect-knockout-rules-v1')throw new Error('invalid_effect_knockout_rules');
const attacks=new Map([...data.purple_attacks,...(data.conditional_purple_attacks??[])].map(rule=>[rule.skill,rule]));
const protections=new Map(data.protections.map(rule=>[rule.ability,rule]));
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;
const types=figure=>{const r=resolveRecordFigure(Number(figure?.id));return r.ok?[r.rule.type0,r.rule.type1]:[];};

export function effectKnockoutProtectionSources(record,positions,conditions,target,emitter,actingSide,edges) {
  if(!field(positions.get(target))||!field(positions.get(emitter)))return [];
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]),targetFigure=figures.find(f=>Number(f.pokemon_index)===target),emitterFigure=figures.find(f=>Number(f.pokemon_index)===emitter);
  if(!targetFigure||!emitterFigure)return [];
  const targetTypes=types(targetFigure),emitterTypes=types(emitterFigure),result=[];
  for(const figure of figures){
    const source=Number(figure.pokemon_index),rule=protections.get(Number(figure.pokepower));
    if(!rule||!field(positions.get(source))||Math.floor(source/6)!==Math.floor(target/6))continue;
    if(rule.target==='self'&&source!==target)continue;
    if(rule.target==='adjacent_allies'&&source!==target&&!edges.some(([a,b])=>a===positions.get(source)&&b===positions.get(target)||b===positions.get(source)&&a===positions.get(target)))continue;
    if(rule.target==='allied_type'&&!targetTypes.includes(rule.target_type))continue;
    if(rule.emitter_type!==undefined&&!emitterTypes.includes(rule.emitter_type))continue;
    if(rule.healthy_target&&data.special_conditions.includes(conditions.get(target)))continue;
    if(rule.owner_turn_only&&(source<6?'black':'white')!==actingSide)continue;
    if(rule.opponents_attacks_only&&Math.floor(emitter/6)===Math.floor(target/6))continue;
    result.push({source,pokepower:rule.ability});
  }
  return result.sort((a,b)=>a.source-b.source);
}

export function purpleEffectKnockoutPlan(record,positions,conditions,emitter,opponent,skill,opposingSkill,actingSide,edges,waits=new Map()) {
  const rule=attacks.get(Number(skill?.id));
  if(!rule||Number(skill.color)!==2||!field(positions.get(emitter))||!field(positions.get(opponent)))return null;
  const figure=(record.players??[]).flatMap(p=>p.pokemons??[]).find(f=>Number(f.pokemon_index)===opponent),targetTypes=types(figure);
  const affected=data.special_conditions.includes(conditions.get(opponent));
  const waiting=Number.isSafeInteger(waits.get(opponent))&&waits.get(opponent)>0;
  const eligible=(rule.opponent_color===undefined||Number(opposingSkill?.color)===rule.opponent_color)
    &&(rule.excluded_target_type===undefined||targetTypes.length>0&&!targetTypes.includes(rule.excluded_target_type))
    &&(!rule.requires_special_condition||affected)&&(!rule.requires_special_condition_or_wait||affected||waiting);
  const candidates=eligible?(rule.target==='both'?[emitter,opponent]:[opponent]).sort((a,b)=>a-b):[];
  const transfers=candidates.map(pokemon=>({pokemon,blocked_by:effectKnockoutProtectionSources(record,positions,conditions,pokemon,emitter,actingSide,edges)}));
  return {skill:rule.skill,emitter,eligible,candidates,targets:transfers.filter(t=>!t.blocked_by.length).map(t=>t.pokemon),transfers,
    ...(rule.wait?{wait:rule.wait,wait_targets:waitTargets(record,[opponent]),wait_before_knockout:!!rule.wait_before_knockout}:{})};
}
