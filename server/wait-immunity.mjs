import {readFileSync} from 'node:fs';
const rules=JSON.parse(readFileSync(new URL('../data/wait_immunity_rules.json',import.meta.url)));
const abilities=new Set(rules.abilities);
const valid=p=>Number.isSafeInteger(p)&&p>=0&&p<12;
export function waitImmunityAbility(record,pokemon){
 if(!valid(pokemon))return null;
 for(const player of record?.players??[])for(const figure of player.pokemons??[]){
  if(Number(figure.pokemon_index)===pokemon)return abilities.has(Number(figure.pokepower))?Number(figure.pokepower):null;
 }
 return null;
}
export function waitTargets(record,targets){return targets.filter(p=>valid(p)&&waitImmunityAbility(record,p)===null);}
// Prevent new positive applications. Recovery to zero and normal countdown are
// separate; dynamic ability acquisition/removal of preexisting Wait is unverified.
export function applyWait(record,waits,pokemon,duration){
 if(!valid(pokemon)||!Number.isSafeInteger(duration)||duration<0||duration>0&&waitImmunityAbility(record,pokemon)!==null)return false;
 waits.set(pokemon,duration);return true;
}
