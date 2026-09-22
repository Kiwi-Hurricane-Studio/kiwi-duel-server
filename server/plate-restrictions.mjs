import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const rules=JSON.parse(readFileSync(new URL('../data/plate_restriction_rules.json',import.meta.url),'utf8'));
if(rules.schema!=='kiwi-plate-restriction-rules-v1')throw new Error('invalid_plate_restriction_rules');
const field=point=>Number.isSafeInteger(point)&&point>=0&&point<28;

// Only recovered action shapes reach the plate validator. A swap targets both
// figures, and a spot move targets its source figure, not a destination neighbor.
export function plateTargetIndexes(positions,nested) {
  if(['select_pokemon','select_pokemon_and_declare_aura'].includes(nested?.type))return [Number(nested.pokemon)];
  if(['put_circle','swap_move'].includes(nested?.type))return Array.isArray(nested.pokemons)?nested.pokemons.map(Number):[];
  if(nested?.type==='spot_move')return [...positions].filter(([,point])=>point===Number(nested.from)).map(([pokemon])=>pokemon);
  return [];
}

export function plateRestrictionSources(record,positions,nested,fieldEdges=[],declaringSide='',conditions=new Map()) {
  const figures=(record?.players??[]).flatMap(player=>player.pokemons??[]);
  const movement=['spot_move','swap_move'].includes(nested?.type),sources=[];
  // Player-wide restrictions apply even when the selected figure is on the
  // bench. Big Chorus counts both teams; its description does not say "your".
  if(['black','white'].includes(declaringSide)) {
    const species=rules.field_species_count_prohibition;
    const politoed=figures.filter(figure=>{
      if(!field(positions.get(Number(figure.pokemon_index))))return false;
      const resolved=resolveRecordFigure(Number(figure.id));
      return resolved.ok&&species.canonical_rule_ids.includes(resolved.rule_id);
    }).map(figure=>Number(figure.pokemon_index));
    for(const figure of figures) {
      const owner=Number(figure.pokemon_index),power=Number(figure.pokepower);
      if(!field(positions.get(owner))||(owner<6?'black':'white')===declaringSide)continue;
      if(rules.healthy_field_opposing_player_prohibition.includes(power)&&!rules.special_conditions.includes(conditions.get(owner)??'normal'))
        sources.push({target:-1,pokemon:owner,pokepower:power,scope:'healthy_field_opposing_player'});
      if(power===species.ability&&politoed.includes(owner)&&politoed.length>=species.minimum)
        sources.push({target:-1,pokemon:owner,pokepower:power,scope:'field_species_count',count:politoed.length});
    }
  }
  for(const target of new Set(plateTargetIndexes(positions,nested))) {
    if(!Number.isSafeInteger(target)||target<0||target>=12||!field(positions.get(target)))continue;
    for(const figure of figures) {
      const owner=Number(figure.pokemon_index),power=Number(figure.pokepower);
      if(!field(positions.get(owner)))continue;
      if(owner===target&&movement&&rules.field_self_movement_prohibition.includes(power))
        sources.push({target,pokemon:owner,pokepower:power,scope:'field_self_movement'});
      if(Math.floor(owner/6)===Math.floor(target/6)||!rules.adjacent_opposing_target_prohibition.includes(power))continue;
      if(fieldEdges.some(([a,b])=>(a===positions.get(owner)&&b===positions.get(target))||(b===positions.get(owner)&&a===positions.get(target))))
        sources.push({target,pokemon:owner,pokepower:power,scope:'adjacent_opposing_target'});
    }
  }
  return sources.sort((a,b)=>a.target-b.target||a.pokemon-b.pokemon);
}
