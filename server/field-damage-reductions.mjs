import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const rules=JSON.parse(readFileSync(new URL('../data/field_damage_reduction_rules.json',import.meta.url))).rules;
const field=p=>Number.isSafeInteger(p)&&p>=0&&p<28;
const index=p=>Number.isSafeInteger(p)&&p>=0&&p<12;
const types=figure=>{const resolved=resolveRecordFigure(Number(figure?.id));return resolved.ok?[resolved.rule.type0,resolved.rule.type1]:[];};

export function fieldDamageReductionSources(record,points,pokemon,opponent,skill,edges){
 if(![1,3].includes(Number(skill?.color))||!index(pokemon)||!index(opponent)||Math.floor(pokemon/6)===Math.floor(opponent/6)||!field(points.get(pokemon))||!field(points.get(opponent)))return [];
 const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]).filter(f=>index(Number(f.pokemon_index))).sort((a,b)=>Number(a.pokemon_index)-Number(b.pokemon_index));
 if(!figures.some(f=>Number(f.pokemon_index)===pokemon))return [];
 const recipient=figures.find(f=>Number(f.pokemon_index)===opponent);if(!recipient)return [];
 const targetPoint=points.get(pokemon),adjacent=new Set(edges.flatMap(([a,b])=>a===targetPoint?[b]:b===targetPoint?[a]:[])),result=[],used=new Set();
 for(const figure of figures){
  const source=Number(figure.pokemon_index),rule=rules.find(r=>r.ability===Number(figure.pokepower));
  if(!rule||!field(points.get(source))||Math.floor(source/6)!==Math.floor(opponent/6)||rule.noncumulative&&used.has(rule.ability))continue;
  if(rule.adjacent_source&&!adjacent.has(points.get(source)))continue;
  if(rule.recipient_types&&!types(recipient).some(type=>rule.recipient_types.includes(type)))continue;
  if(rule.adjacent_ally_type!==undefined){
   const counted=figures.filter(f=>Math.floor(Number(f.pokemon_index)/6)===Math.floor(source/6)&&field(points.get(Number(f.pokemon_index)))&&adjacent.has(points.get(Number(f.pokemon_index)))&&types(f).includes(rule.adjacent_ally_type)).map(f=>Number(f.pokemon_index));
   if(!counted.length)continue;
   result.push({source,pokepower:rule.ability,addend:-rule.per_figure*counted.length,multiplicand:-rule.per_figure,multiplier:counted.length,counted});
  }else result.push({source,pokepower:rule.ability,addend:-rule.reduction});
  if(rule.noncumulative)used.add(rule.ability);
 }
 return result;
}

export function applyFieldDamageReductions(record,points,pokemon,opponent,skill,edges){
 const sources=fieldDamageReductionSources(record,points,pokemon,opponent,skill,edges);if(!sources.length)return skill;
 let current=Number(skill.speed_or_damage);
 skill.field_damage_reductions=sources.map(source=>{const result=Math.max(0,current+source.addend),change={...source,current,result};current=result;return change;});
 skill.speed_or_damage=current;return skill;
}
