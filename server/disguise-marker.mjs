// Original ability1265/figure1363: native Stony field/Balloon histories
// attach the Disguise triangle on bench-to-field entry, before Sandwich.
// Battle replacement is separately pinned to native Disguise contracts v1-v6.
export function disguiseEntryTargets(record,before,after) {
  return (record?.players??[]).flatMap(p=>p.pokemons??[]).filter(f=>{
    const p=f.pokemon_index,origin=before.get(p),target=after.get(p);
    return Number.isSafeInteger(p)&&p>=0&&p<12&&Number(f.pokepower)===1265
      &&Number.isSafeInteger(origin)&&origin>=28&&origin<40
      &&Math.floor((origin-28)/6)===Math.floor(p/6)
      &&Number.isSafeInteger(target)&&target>=0&&target<28;
  }).map(f=>f.pokemon_index).sort((a,b)=>a-b);
}

// A battle still reports Faint before the marker replaces that knockout.
// Keep Wait and the battle winner; only the triangle and Circle are cleared.
export function consumeDisguiseMarkers(match, targets) {
  const protectedTargets=[...new Set(targets)].filter(p=>match.triangles.get(p)==='bake_no_kawa');
  for (const pokemon of protectedTargets) {
    match.triangles.set(pokemon,'empty');
    match.conditions.set(pokemon,'normal');
  }
  return protectedTargets;
}
