import {readFileSync} from 'node:fs';
const rules=JSON.parse(readFileSync(new URL('../data/post_mp_battle_rules.json',import.meta.url)));
const activeAbilities=new Set([...rules.self_attack_bans,...rules.adjacent_opposing_attack_bans,...rules.adjacent_opposing_required_targets]);
const commands=new Set(['mp_move','route_move','spot_move','declare_plate','declare_battle','declare_respin','null_move','declare_turn_end','resign','z_skill','touch']);
const field=p=>Number.isSafeInteger(p)&&p>=0&&p<28;
const valid=p=>Number.isSafeInteger(p)&&p>=0&&p<12;
const same=(a,b)=>(a<6)===(b<6);

// Call only for the battle continuation of an actual MP move. No effect notice
// is invented: the existing movement/battle/turn actions express the outcome.
export function postMpBattlePolicy(record,points,mover,graph){
 const blocked=[],required=[];
 if(!valid(mover)||!field(points.get(mover)))return {blocked,required};
 const figures=(record?.players??[]).flatMap(p=>p.pokemons??[]).filter(f=>activeAbilities.has(Number(f.pokepower))&&valid(Number(f.pokemon_index))).sort((a,b)=>a.pokemon_index-b.pokemon_index);
 for(const f of figures){
  const source=Number(f.pokemon_index),ability=Number(f.pokepower),point=points.get(source);
  if(!field(point))continue;
  if(source===mover&&rules.self_attack_bans.includes(ability))blocked.push({source,pokepower:ability});
  if(same(source,mover)||!(graph.get(points.get(mover))??[]).includes(point))continue;
  if(rules.adjacent_opposing_attack_bans.includes(ability))blocked.push({source,pokepower:ability});
  if(rules.adjacent_opposing_required_targets.includes(ability))required.push(source);
 }
 return {blocked,required};
}

export function restrictPostMpBattles(record,points,mover,graph,choices){
 const policy=postMpBattlePolicy(record,points,mover,graph);
 if(policy.blocked.length)return {...policy,choices:[],mandatory:false};
 const required=choices.filter(c=>policy.required.includes(Number(c.value.to_pokemon)));
 return {...policy,choices:required.length?required:choices,mandatory:required.length>0};
}

// Ignore generated effects, but never carry an MP obligation past another
// player command or onto a different player/figure's turn.
export function latestMpMover(record,points,side){
 for(let i=(record.all_moves??[]).length-1;i>=0;i--){
  const move=record.all_moves[i],type=move.value?.type;
  if(!commands.has(type))continue;
  if(type!=='mp_move'||move.selective_side!==side)return -1;
  const route=move.value.route;
  if(!Array.isArray(route)||route.length<2)return -1;
  const matches=[...points].filter(([p,point])=>valid(p)&&field(point)&&point===route.at(-1)&&(p<6?'black':'white')===side);
  return matches.length===1?matches[0][0]:-1;
 }
 return -1;
}
