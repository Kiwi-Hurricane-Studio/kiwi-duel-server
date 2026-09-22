// Original ARM Touch studies: allied adjacent Sleep/Freeze/Melt recovery.
// Separate from RemoveDebuff: Touch preserves the target's Triangle and Wait.
const conditions = new Set(['sleep', 'freeze', 'melt']);
const sideOf = pokemon => pokemon < 6 ? 'black' : 'white';
const field = point => Number.isInteger(point) && point >= 0 && point < 28;

export function touchRecoveryChoices(side, positions, circles, waits, graph, sources = null) {
  if (!['black', 'white'].includes(side)) return [];
  const first = side === 'black' ? 0 : 6;
  const targets = [];
  for (let pokemon = first; pokemon < first + 6; pokemon++) {
    if (field(positions.get(pokemon)) && conditions.has(circles.get(pokemon))) targets.push(pokemon);
  }
  if (!targets.length) return [];
  targets.sort((a,b)=>positions.get(a)-positions.get(b));
  const result = [];
  for (let pokemon = first; pokemon < first + 6; pokemon++) {
    if (sources && !sources.includes(pokemon)) continue;
    const source = positions.get(pokemon);
    if (!field(source) || Number(waits.get(pokemon) ?? 0) > 0 || conditions.has(circles.get(pokemon))) continue;
    const neighbors = graph.get(source) ?? [];
    for (const target of targets) {
      if (target !== pokemon && neighbors.includes(positions.get(target))) result.push({
        selective_side: side, value: {from_pokemon: pokemon, to_pokemon: target, type: 'touch'},
      });
    }
  }
  return result;
}

export function validTouchRecovery(move, choices) {
  const value = move?.value;
  if (!value || Object.keys(value).sort().join(',') !== 'from_pokemon,to_pokemon,type'
      || value.type !== 'touch' || !Number.isInteger(value.from_pokemon) || !Number.isInteger(value.to_pokemon)
      || value.from_pokemon < 0 || value.from_pokemon >= 12 || value.to_pokemon < 0 || value.to_pokemon >= 12
      || move.selective_side !== sideOf(value.from_pokemon)) return false;
  return choices.some(candidate => candidate.selective_side === move.selective_side
    && candidate.value.from_pokemon === value.from_pokemon && candidate.value.to_pokemon === value.to_pokemon);
}
