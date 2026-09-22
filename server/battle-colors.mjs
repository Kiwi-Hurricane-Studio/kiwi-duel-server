import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/battle_color_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-battle-color-rules-v1')throw new Error('invalid_battle_color_rules');
const rules=new Map(data.rules.map(rule=>[rule.ability,rule]));
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;

export function withinBattleColorDistance(from,to,edges,maximum) {
  if(!field(from)||!field(to))return false;
  const seen=new Set([from]);let frontier=[from];
  for(let distance=0;distance<=maximum;distance++){
    if(frontier.includes(to))return true;
    const next=[];
    for(const point of frontier)for(const [a,b]of edges){const candidate=a===point?b:b===point?a:-1;if(field(candidate)&&!seen.has(candidate)){seen.add(candidate);next.push(candidate);}}
    frontier=next;
  }
  return false;
}

export function battleColorActions(record,positions,battled,attacker,defender=-1,edges=[],actingSide='') {
  const figures=new Map((record?.players??[]).flatMap(p=>p.pokemons??[]).map(f=>[Number(f.pokemon_index),f]));
  const participants=[...new Set([attacker,defender])].filter(p=>figures.has(p)&&field(positions.get(p)));
  const wheels=new Map(participants.map(p=>[p,(figures.get(p).skills??[]).filter(s=>Number(s.range)>0).map(s=>({...s}))]));
  const sources=[...participants,...[...figures.keys()].filter(p=>!participants.includes(p)).sort((a,b)=>a-b)];
  if(!['black','white'].includes(actingSide))actingSide=attacker<6?'black':'white';
  const actions=[];
  // The original client restores speed-up, then speed-down. Engine conflict
  // priority is still a derived boundary; preserve both explicit operations.
  for(const toColor of [3,1])for(const source of sources) {
    const rule=rules.get(Number(figures.get(source).pokepower));
    if(!rule||rule.to_color!==toColor||!field(positions.get(source))||(rule.first_battle&&battled.get(source)))continue;
    if(rule.owner_turn_only&&(source<6?'black':'white')!==actingSide)continue;
    if(rule.adjacent_species_rule_ids&&!sources.some(p=>{
      if(p===source||!field(positions.get(p))||positions.get(p)===positions.get(source)||!withinBattleColorDistance(positions.get(source),positions.get(p),edges,1))return false;
      const resolved=resolveRecordFigure(Number(figures.get(p).id));
      return resolved.ok&&rule.adjacent_species_rule_ids.includes(resolved.rule_id);
    }))continue;
    let targets=[];
    if(rule.target==='self'&&participants.includes(source))targets=[source];
    if(rule.target==='opponent'&&participants.includes(source))targets=[source===attacker?defender:attacker];
    if(rule.target==='nearby')targets=participants.filter(p=>withinBattleColorDistance(positions.get(source),positions.get(p),edges,rule.distance));
    if(rule.target==='allied_type_opponents')targets=participants.filter(p=>{
      const resolved=resolveRecordFigure(Number(figures.get(p).id));
      return Math.floor(p/6)===Math.floor(source/6)&&resolved.ok&&rule.protected_types.some(type=>[resolved.rule.type0,resolved.rule.type1].includes(type));
    }).map(p=>p===attacker?defender:attacker);
    const changes=[];
    if(rule.target_order==='defender_first')targets.reverse();
    for(const target of [...new Set(targets)]){
      const wheel=wheels.get(target);if(!wheel)continue;
      const ids=[...new Set(wheel.filter(s=>Number(s.color)===rule.from_color&&Number(s.id)>0).map(s=>Number(s.id)))].sort((a,b)=>a-b);
      if(!ids.length)continue;
      changes.push({pokemon:target,skill_id:ids,type:toColor===3?'speedup_skill':'speeddown_skill'});
      for(const skill of wheel)if(ids.includes(Number(skill.id)))skill.color=toColor;
    }
    if(!changes.length)continue;
    if(rule.announce!==false)actions.push({pokemon:source,pokepower:rule.ability,type:'pokepower_notice'});
    actions.push(...changes);
  }
  return actions;
}

export function applyBattleColorActions(pokemon,skill,actions) {
  if(!skill||skill.z_skill||skill.disabled_replacement)return skill;
  for(const action of actions) {
    if(!['speedup_skill','speeddown_skill'].includes(action.type)||action.pokemon!==pokemon||!action.skill_id.includes(Number(skill.id)))continue;
    if(skill.original_color===undefined)skill.original_color=Number(skill.color);
    skill.color=action.type==='speedup_skill'?3:1;
    skill[action.type]=true;
  }
  return skill;
}
