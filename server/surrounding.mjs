import {readFileSync} from 'node:fs';
const rules=JSON.parse(readFileSync(new URL('../data/surround_rules.json',import.meta.url),'utf8'));
if(rules.schema!=='kiwi-surround-rules-v1')throw new Error('invalid_surround_rules');

// This predicate is shared by MP/plate movement admission and its committed
// outcome. It never moves figures or treats Attack-only KO protection as a
// surround immunity. Batch membership is decided before any Center mutation.
export function surroundingPlan(record,positions,conditions,edges) {
  const figures=new Map((record?.players??[]).flatMap(player=>player.pokemons??[]).map(f=>[Number(f.pokemon_index),f]));
  const occupied=new Map(),candidates=[],targets=[],blocked=[];
  for(const [pokemon,point] of positions){
    if(!Number.isSafeInteger(pokemon)||pokemon<0||pokemon>11||!Number.isSafeInteger(point)||point < -1||(point>43&&point!==44+pokemon)||point>=0&&occupied.has(point)||!figures.has(pokemon))
      return {ok:false,reason:'surround_invalid_occupancy',candidates:[],targets:[],blocked:[]};
    if(point>=0)occupied.set(point,pokemon); // -1 is absence, not a shared board point.
  }
  for(const [pokemon,point] of [...positions].sort(([a],[b])=>a-b)){
    if(point<0||point>=28||conditions.get(pokemon)==='faint')continue;
    const neighbors=edges.flatMap(([a,b])=>a===point?[b]:b===point?[a]:[]);
    if(!neighbors.length)continue;
    const contributors=neighbors.map(p=>occupied.get(p));
    if(contributors.some(p=>p===undefined||Math.floor(p/6)===Math.floor(pokemon/6)
      ||rules.noncontributing_abilities.includes(Number(figures.get(p).pokepower))
      ||rules.noncontributing_conditions.includes(conditions.get(p))))continue;
    contributors.sort((a,b)=>a-b);
    const candidate={pokemon,contributors};candidates.push(candidate);
    const ability=Number(figures.get(pokemon).pokepower);
    if(rules.immune_abilities.includes(ability)){blocked.push({...candidate,ability});continue;}
    if(rules.unresolved_victim_abilities.includes(ability)
      ||contributors.some(p=>rules.unresolved_contributor_abilities.includes(Number(figures.get(p).pokepower))))
      return {ok:false,reason:'surround_replacement_unimplemented',candidates,targets:[],blocked};
    targets.push(pokemon);
  }
  return {ok:true,reason:'',candidates,targets,blocked};
}
