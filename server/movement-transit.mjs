import {readFileSync} from 'node:fs';
import {resolveRecordFigure} from './z-skill-catalog.mjs';
const rules=JSON.parse(readFileSync(new URL('../data/movement_transit_rules.json',import.meta.url)));
const conditionalGrants=new Map(rules.conditional_field_grants.map(r=>[r.ability,r]));
const typedGrants=new Map(rules.typed_self_field_grants.map(r=>[r.ability,r]));
const providerGrants=new Map(rules.provider_field_grants.map(r=>[r.ability,r]));
const benchEntries=new Map(rules.bench_spot_entries.map(r=>[r.ability,r]));
const activeAbilities=new Set([...rules.holder_field_grants,...benchEntries.keys(),...rules.self_field_grants,...rules.typed_self_field_grants.map(r=>r.ability),...rules.conditional_field_grants.map(r=>r.ability),...rules.provider_field_grants.map(r=>r.ability),...rules.adjacent_opposing_mp_blockers]);
const valid=p=>Number.isSafeInteger(p)&&p>=0&&p<12,field=p=>Number.isSafeInteger(p)&&p>=0&&p<28,same=(a,b)=>Math.floor(a/6)===Math.floor(b/6);
const types=f=>{const result=resolveRecordFigure(Number(f?.id));return result.ok?[result.rule.type0,result.rule.type1].filter(t=>t!==null):[];};
const matches=(f,allowed)=>types(f).some(t=>allowed.includes(t));

export function hasMovementTransit(record,points){
 return (record?.players??[]).some(player=>(player.pokemons??[]).some(figure=>{const p=Number(figure.pokemon_index),ability=Number(figure.pokepower),point=points.get(p);return valid(p)&&activeAbilities.has(ability)&&(field(point)||typedGrants.has(ability)&&point===28+p||hasBenchSpotEntry(ability,point));}));
}

export function hasBenchSpotEntry(ability,point){return benchEntries.has(Number(ability))&&Number.isSafeInteger(point)&&point>=28&&point<40;}

export function benchSpotEntryTargets(context,pokemon){
 if(!context||!valid(pokemon)||!context.figures.has(pokemon))return [];
 const ability=Number(context.figures.get(pokemon).pokepower),rule=benchEntries.get(ability);
 if(!hasBenchSpotEntry(ability,context.points.get(pokemon))||Number(context.waits.get(pokemon)??0)>0||rule.use_blocking_conditions.includes(context.conditions.get(pokemon)))return [];
 return rule.targets[pokemon<6?'black':'white'].filter(point=>![...context.points.values()].includes(point));
}

export function holderMovementTransitGrant(context,pokemon,through){
 if(!valid(pokemon)||!valid(through)||pokemon===through||!same(pokemon,through)||!context.figures.has(pokemon)||!context.figures.has(through)||!field(context.points.get(pokemon))||!field(context.points.get(through)))return null;
 const ability=Number(context.figures.get(through).pokepower);
 return rules.holder_field_grants.includes(ability)?{source:through,pokepower:ability}:null;
}

export function movementTransitContext(record,points,conditions,edges,waits=new Map()){
 const figures=new Map((record?.players??[]).flatMap(p=>p.pokemons??[]).filter(f=>valid(Number(f.pokemon_index))).map(f=>[Number(f.pokemon_index),f]));
 const adjacent=new Map();for(const [a,b] of edges){if(!adjacent.has(a))adjacent.set(a,new Set());if(!adjacent.has(b))adjacent.set(b,new Set());adjacent.get(a).add(b);adjacent.get(b).add(a);}
 const holders=[...figures.keys()].filter(p=>field(points.get(p))).sort((a,b)=>a-b);
 return {figures,points,waits,conditions:conditions??new Map(),adjacent,holders,barriers:holders.filter(p=>rules.unverified_adjacent_route_barriers.includes(Number(figures.get(p).pokepower)))};
}

export function movementTransitGrant(context,pokemon){
 if(!valid(pokemon)||!field(context.points.get(pokemon)))return null;
 const ability=Number(context.figures.get(pokemon)?.pokepower);
 return rules.self_field_grants.includes(ability)?{source:pokemon,pokepower:ability}:null;
}

export function conditionalMovementTransitGrant(context,pokemon,through){
 if(!valid(pokemon)||!valid(through)||pokemon===through||!field(context.points.get(pokemon))||!field(context.points.get(through))||!context.figures.has(through))return null;
 const rule=conditionalGrants.get(Number(context.figures.get(pokemon)?.pokepower));
 if(!rule)return null;
 const eligible=rule.occupant_positive_wait&&Number(context.waits.get(through)??0)>0||rule.occupant_conditions.includes(context.conditions.get(through));
 return eligible?{source:pokemon,pokepower:rule.ability}:null;
}

export function typedMovementTransitGrant(context,pokemon,through){
 if(!valid(pokemon)||!valid(through)||pokemon===through||!context.figures.has(pokemon)||!context.figures.has(through)||!field(context.points.get(pokemon))||!field(context.points.get(through)))return null;
 const rule=typedGrants.get(Number(context.figures.get(pokemon).pokepower));
 return rule&&(same(pokemon,through)||matches(context.figures.get(through),rule.opposing_types))?{source:pokemon,pokepower:rule.ability}:null;
}

export function entryBlockadeMpBonus(context,pokemon){
 if(!context||!valid(pokemon)||!context.figures.has(pokemon)||!typedGrants.has(Number(context.figures.get(pokemon).pokepower)))return 0;
 const point=context.points.get(pokemon);if(!field(point)&&point!==28+pokemon)return 0;
 return rules.entry_points[pokemon<6?'black':'white'].every(entry=>context.holders.some(p=>!same(p,pokemon)&&context.points.get(p)===entry))?rules.entry_blockade_mp_bonus:0;
}

export function providerMovementTransitGrants(context,pokemon,through){
 if(!valid(pokemon)||!valid(through)||pokemon===through||!field(context.points.get(pokemon))||!field(context.points.get(through))||!context.figures.has(pokemon)||!context.figures.has(through))return [];
 const result=[];
 for(const source of context.holders){
  const rule=providerGrants.get(Number(context.figures.get(source).pokepower));
  if(!rule||!same(source,pokemon)||!matches(context.figures.get(pokemon),rule.mover_types))continue;
  if(rule.occupant_types&&!matches(context.figures.get(through),rule.occupant_types))continue;
  if(rule.healthy_source&&rules.special_conditions.includes(context.conditions.get(source))||rule.healthy_mover&&rules.special_conditions.includes(context.conditions.get(pokemon)))continue;
  result.push({source,pokepower:rule.ability});
 }
 return result;
}

function connected(context,source,target){
 const visited=new Set([source]),pending=[source];
 while(pending.length){const current=pending.shift();if(current===target)return true;for(const p of context.holders)if(!visited.has(p)&&same(source,p)&&context.adjacent.get(context.points.get(current))?.has(context.points.get(p))){visited.add(p);pending.push(p);}}
 return false;
}

function transitBlockers(context,pokemon,through,allowBench=false){
 if(!context||!valid(pokemon)||!valid(through)||pokemon===through||!context.figures.has(pokemon)||!context.figures.has(through)||(!field(context.points.get(pokemon))&&!(allowBench&&context.points.get(pokemon)===28+pokemon))||!field(context.points.get(through)))return [];
 const blocked=[];
 for(const source of context.holders)for(const rule of rules.blockers){
  if(Number(context.figures.get(source).pokepower)!==rule.ability||rule.mover_side==='opposing'&&same(source,pokemon))continue;
  if(rule.scope==='self'&&source!==through||rule.scope==='team'&&!same(source,through)||rule.scope==='connected'&&(!same(source,through)||!connected(context,source,through)))continue;
  if(rule.mover_types&&!matches(context.figures.get(pokemon),rule.mover_types)||rule.occupant_types&&!matches(context.figures.get(through),rule.occupant_types))continue;
  if(rule.exempt_mover_types&&matches(context.figures.get(pokemon),rule.exempt_mover_types)||rule.mover_conditions&&!rule.mover_conditions.includes(context.conditions.get(pokemon)))continue;
  if(!blocked.some(b=>b.source===source&&b.pokepower===rule.ability))blocked.push({source,pokepower:rule.ability});
 }
 return blocked;
}

export function movementTransitBlockers(context,pokemon,through){return transitBlockers(context,pokemon,through);}

// These original clauses block MP passage itself. Ghost Sensor and the other
// ability-effect-only blockers do not negate plate or frozen-figure passage.
export function movementNonAbilityTransitBlockers(context,pokemon,through){
 return transitBlockers(context,pokemon,through,true).filter(b=>[1032,1051,1300].includes(b.pokepower));
}

export function canAbilityTransit(context,pokemon,through){
 return !!(holderMovementTransitGrant(context,pokemon,through)||movementTransitGrant(context,pokemon)||conditionalMovementTransitGrant(context,pokemon,through)||typedMovementTransitGrant(context,pokemon,through)||providerMovementTransitGrants(context,pokemon,through).length)&&valid(through)&&pokemon!==through&&context.figures.has(through)&&field(context.points.get(through))&&!movementTransitBlockers(context,pokemon,through).length;
}

export function movementMpBlockers(context,pokemon){
 if(!valid(pokemon)||!field(context.points.get(pokemon)))return [];
 return context.holders.filter(source=>!same(source,pokemon)&&rules.adjacent_opposing_mp_blockers.includes(Number(context.figures.get(source).pokepower))&&context.adjacent.get(context.points.get(source))?.has(context.points.get(pokemon))).map(source=>({source,pokepower:Number(context.figures.get(source).pokepower)}));
}

export function unverifiedTransitRouteBlockers(context,pokemon,route){
 // Only withhold newly enabled occupied-transit routes. Exact Earthen Rage
 // treatment of empty points, start/end points and alternate moves is unresolved.
 if(!context.barriers.length)return [];
 const crossed=route.slice(1,-1).some(point=>context.holders.some(p=>p!==pokemon&&context.points.get(p)===point));if(!crossed)return [];
 return context.barriers.filter(source=>!same(source,pokemon)&&route.some(point=>context.adjacent.get(context.points.get(source))?.has(point))).map(source=>({source,pokepower:Number(context.figures.get(source).pokepower),reason:'earthen_rage_traversal_scope_unverified'}));
}
