// Original1247 entry/DeclareSpin/probability witnesses are preserved in
// grudge-entry-phase-contract.json. This phase does not resolve a battle.
export function grudgeStoneEntry(record,before,after){
  const holders=(record.players??[]).flatMap(p=>p.pokemons??[]).filter(p=>Number(p.pokepower)===1247);
  return holders.map(p=>Number(p.pokemon_index)).find(p=>before.get(p)===28+p&&after.get(p)>=0&&after.get(p)<28)??-1;
}
export function grudgeStoneChoices(side,points){
  return [...points].filter(([p,point])=>Number.isInteger(p)&&p>=0&&p<12&&point>=0&&point<28)
    .sort(([a],[b])=>a-b).map(([p])=>({selective_side:side,value:{pokemons:[p],type:'declare_spin'}}));
}
export function validGrudgeSelection(move,side,points){
  const value=move?.value;
  return move?.selective_side===side&&value&&Object.keys(value).sort().join(',')==='pokemons,type'
    &&value.type==='declare_spin'&&Array.isArray(value.pokemons)&&value.pokemons.length===1
    &&Number.isInteger(value.pokemons[0])&&grudgeStoneChoices(side,points).some(a=>a.value.pokemons[0]===value.pokemons[0]);
}
