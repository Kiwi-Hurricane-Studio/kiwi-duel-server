import {waitTargets as eligibleWaitTargets} from './wait-immunity.mjs';
import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const data=JSON.parse(readFileSync(new URL('../data/bench_attack_rules.json',import.meta.url),'utf8'));
if(data.schema!=='kiwi-bench-attack-rules-v1')throw new Error('invalid_bench_attack_rules');
const attacks=new Map(data.attacks.map(rule=>[rule.id,rule]));
const field=point=>Number.isInteger(point)&&point>=0&&point<28;
const side=pokemon=>Math.floor(pokemon/6);
const adjacent=(edges,a,b)=>edges.some(([from,to])=>(from===a&&to===b)||(from===b&&to===a));

export function benchMovementProtectionSources(record,positions,emitter,target,battleOpponent,fieldEdges=[]) {
  const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]);
  if(!field(positions.get(target))||!field(positions.get(emitter)))return [];
  const selected=figures.find(p=>Number(p.pokemon_index)===target),ability=Number(selected?.pokepower);
  const sources=[];
  if(target!==emitter&&data.other_attack_protection.includes(ability))sources.push({pokemon:target,pokepower:ability,scope:'other_attack'});
  if(target===battleOpponent&&data.battle_opponent_protection.includes(ability))sources.push({pokemon:target,pokepower:ability,scope:'battle_opponent'});
  for(const figure of figures) {
    const owner=Number(figure.pokemon_index),power=Number(figure.pokepower);
    if(!data.adjacent_opposing_team_traps.includes(power)||!field(positions.get(owner)))continue;
    // Both opposing-Pokemon clauses are anchored to this ability owner.
    // This traps the enemy team's own retreat, including a self-return Attack.
    if(side(owner)===side(target)||side(owner)===side(emitter)||!adjacent(fieldEdges,positions.get(owner),positions.get(target)))continue;
    sources.push({pokemon:owner,pokepower:power,scope:'adjacent_opposing_team'});
  }
  return sources.sort((a,b)=>a.pokemon-b.pokemon||a.pokepower-b.pokepower);
}

export function benchAttackPlan(record,positions,winner,loser,skill,fieldEdges=[]) {
  const rule=attacks.get(Number(skill?.id));
  if(!rule||Number(skill.color)!==2)return null;
  const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]);
  if(![winner,loser].every(p=>Number.isInteger(p)&&p>=0&&p<12&&figures.some(f=>Number(f.pokemon_index)===p)&&field(positions.get(p)))
    ||side(winner)===side(loser))throw new Error('invalid_bench_attack_target');
  const targets=rule.targets==='self'?[winner]:rule.targets==='adjacent'?
    figures.map(p=>Number(p.pokemon_index)).filter(p=>field(positions.get(p))&&adjacent(fieldEdges,positions.get(winner),positions.get(p))):[loser];
  targets.sort((a,b)=>a-b);
  const transfers=targets.map(pokemon=>{
    const sources=benchMovementProtectionSources(record,positions,winner,pokemon,loser,fieldEdges),to=28+pokemon;
    if(!sources.length&&[...positions.values()].includes(to))throw new Error('occupied_bench_attack_destination');
    return {pokemon,from:positions.get(pokemon),to,wait:rule.wait,blocked_by:sources[0]?.pokepower??null,protection_sources:sources};
  });
  const waitTargets=new Set(targets);
  if(rule.wait_targets==='opponent_and_opposing_flying')for(const figure of figures) {
    const pokemon=Number(figure.pokemon_index);if(side(pokemon)===side(winner)||!field(positions.get(pokemon)))continue;
    const resolved=resolveRecordFigure(Number(figure.id));
    if(resolved.ok&&[resolved.rule.type0,resolved.rule.type1].includes(data.flying_type))waitTargets.add(pokemon);
  }
  // Validate every destination before returning the complete transaction.
  return {...transfers[0],transfers,wait:rule.wait,wait_targets:eligibleWaitTargets(record,[...waitTargets].sort((a,b)=>a-b))};
}
