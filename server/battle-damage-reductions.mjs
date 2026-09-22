import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/battle_damage_reduction_rules.json',import.meta.url)));
const special=new Set(['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']);
const field=p=>Number.isSafeInteger(p)&&p>=0&&p<28;

export function battleDamageReductionSource(record,points,conditions,pokemon,opponent,skill){
 if(![1,3].includes(Number(skill?.color))||!Number.isSafeInteger(pokemon)||!Number.isSafeInteger(opponent)||pokemon<0||opponent<0||pokemon>=12||opponent>=12||Math.floor(pokemon/6)===Math.floor(opponent/6)||!field(points.get(pokemon))||!field(points.get(opponent)))return null;
 const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]),holder=figures.find(f=>Number(f.pokemon_index)===opponent),attacker=figures.find(f=>Number(f.pokemon_index)===pokemon);
 const rule=data.rules.find(r=>r.ability===Number(holder?.pokepower));if(!rule||!attacker)return null;
 if(rule.holder_special_condition&&!special.has(conditions.get(opponent)))return null;
 if(rule.attacker_type!==undefined){const resolved=resolveRecordFigure(Number(attacker.id));if(!resolved.ok||![resolved.rule.type0,resolved.rule.type1].includes(rule.attacker_type))return null;}
 return {source:opponent,pokepower:rule.ability,addend:-rule.reduction};
}

export function applyBattleDamageReduction(record,points,conditions,pokemon,opponent,skill){
 if(Number(skill.printed_damage??skill.speed_or_damage)===0)return skill;
 const source=battleDamageReductionSource(record,points,conditions,pokemon,opponent,skill);if(!source)return skill;
 const current=Number(skill.speed_or_damage),result=current+source.addend;
 skill.battle_damage_reduction={...source,current,result};skill.speed_or_damage=Math.max(0,result);return skill;
}
