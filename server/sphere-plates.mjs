import {resolveRecordFigure} from './z-skill-catalog.mjs';
import {withinBattleColorDistance} from './battle-colors.mjs';

const field = point => Number.isSafeInteger(point) && point >= 0 && point < 28;
export const SUPPORTED_SPHERE_IDS = Object.freeze([5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416, 5445]);
const targetTypes = new Map([[5377, 6], [5378, 15], [5379, 7], [5380, 1], [5386, 0], [5404, 14], [5412, 16], [5416, 8], [5445, 9]]);
function hasType(record, pokemon, type) {
  const figure = (record.players ?? []).flatMap(p => p.pokemons ?? []).find(p => p.pokemon_index === pokemon);
  const resolved = resolveRecordFigure(Number(figure?.id));
  return resolved.ok && [resolved.rule.type0, resolved.rule.type1].includes(type);
}
export const isSteelFigure = (record, pokemon) => hasType(record, pokemon, 6);
export function isSphereTarget(record, pokemon, plateId) {
  return targetTypes.has(plateId) && hasType(record, pokemon, targetTypes.get(plateId));
}

// Suppression changes the holder's effective charge and emitted aura, not the
// equipped copy. Bench/P.C. holders and Frost itself retain their attachment.
export function sphereAttachmentSuppressed(positions, state, attachment, edges) {
  if (attachment.plate_id === 5445 || !SUPPORTED_SPHERE_IDS.includes(attachment.plate_id)
      || !field(positions.get(attachment.pokemon))) return false;
  return (state?.attachments ?? []).some(source => {
    if (source.plate_id !== 5445 || Math.floor(source.pokemon / 6) === Math.floor(attachment.pokemon / 6)
        || !field(positions.get(source.pokemon))
        || state.plate_conditions.find(p => p.color === source.side)?.plates[source.slot]?.condition !== 'aura') return false;
    if (!Array.isArray(edges) || !edges.length) throw new Error('frost_board_edges_required');
    return withinBattleColorDistance(positions.get(source.pokemon), positions.get(attachment.pokemon), edges, 3);
  });
}

// Attachments identify the equipped copy and its holder. A beneficiary's
// native effect.ids.plates is derived aura membership, never ownership.
export function metalSphereSources(record, positions, state, pokemon, edges = []) {
  return sphereSources(record, positions, state, pokemon, 5377, edges);
}

export function sphereSources(record, positions, state, pokemon, plateId, edges = []) {
  if (![5377, 5378, 5379, 5380, 5386, 5404, 5412, 5416].includes(plateId) || !state?.attachments?.some(a => a.plate_id === plateId)) return [];
  // Native status lists aura membership on allied bench recipients too.
  // The holder's field location is the activation predicate.
  if (!isSphereTarget(record, pokemon, plateId) || plateId === 5412 && !dragonLowMpRecipient(record,pokemon)) return [];
  return (state?.attachments ?? []).filter(a => a.plate_id === plateId
    && Math.floor(a.pokemon / 6) === Math.floor(pokemon / 6) && field(positions.get(a.pokemon))
    && state.plate_conditions.find(p => p.color === a.side)?.plates[a.slot]?.condition === 'aura'
    && !sphereAttachmentSuppressed(positions, state, a, edges));
}

export function applyMetalSphereDamage(record, positions, state, pokemon, skill, edges = []) {
  // Original ItemDescription5377: White >=10 only; effects do not stack.
  if (Number(skill?.color) !== 1 || Number(skill.printed_damage ?? skill.speed_or_damage) < 10
      || !metalSphereSources(record, positions, state, pokemon, edges).length) return skill;
  const current = Number(skill.speed_or_damage);
  (skill.sphere_damage ??= []).push({plate_id:5377, current, addend:10, result:current + 10});
  skill.speed_or_damage = current + 10;
  return skill;
}

export function metalSpherePrevents(record, positions, state, pokemon, condition, edges = []) {
  return ['poison', 'bad_poison'].includes(condition)
    && metalSphereSources(record, positions, state, pokemon, edges).length > 0;
}

export function spherePreventionPlate(record, positions, state, pokemon, condition, edges = []) {
  const plateId = ['poison', 'bad_poison'].includes(condition) ? 5377 : ['burn', 'freeze'].includes(condition) ? 5379 : -1;
  return sphereSources(record, positions, state, pokemon, plateId, edges).length ? plateId : -1;
}

export function flameSphereTransitPairs(record, positions, state, conditions, edges) {
  const pairs = new Set();
  if (!state?.attachments?.some(a => a.plate_id === 5379)) return pairs;
  const burned = [...conditions].filter(([pokemon, condition]) => condition === 'burn' && field(positions.get(pokemon))).map(([pokemon]) => pokemon);
  if (!burned.length) return pairs;
  for (const [pokemon, point] of positions) {
    if (!Number.isSafeInteger(point) || point < 0 || point >= 40 || !sphereSources(record, positions, state, pokemon, 5379, edges).length) continue;
    for (const through of burned) if (through !== pokemon) pairs.add(pokemon * 12 + through);
  }
  return pairs;
}

// Phantom's aura membership persists on field recipients, but its movement
// clause applies only to an MP move originating on that figure's own bench.
export function phantomSphereTransitPairs(record, positions, state, conditions, edges) {
  const pairs = new Set();
  if (!state?.attachments?.some(a => a.plate_id === 5378)) return pairs;
  const special = new Set(['bad_poison', 'burn', 'freeze', 'melt', 'panic', 'paralyze', 'poison', 'sleep']);
  const occupants = [...positions].filter(([pokemon, point]) => field(point)
    && (hasType(record, pokemon, 15) || special.has(conditions.get(pokemon)))).map(([pokemon]) => pokemon);
  if (!occupants.length) return pairs;
  for (const [pokemon, point] of positions) {
    if (point !== 28 + pokemon || !sphereSources(record, positions, state, pokemon, 5378, edges).length) continue;
    for (const through of occupants) pairs.add(pokemon * 12 + through);
  }
  return pairs;
}

// Native compound controls establish Metal before Electro, independent of
// declaration order. Multiple providers do not multiply either bonus.
export function applySphereDamage(record, positions, state, pokemon, skill, edges = []) {
  applyMetalSphereDamage(record, positions, state, pokemon, skill, edges);
  if (![1,3].includes(Number(skill?.color)) || Number(skill.printed_damage ?? skill.speed_or_damage) <= 0
      || !field(positions.get(pokemon)) || !sphereSources(record, positions, state, pokemon, 5380, edges).length) return skill;
  const point = positions.get(pokemon), adjacent = new Set();
  for (const [a,b] of edges) { if (a === point) adjacent.add(b); if (b === point) adjacent.add(a); }
  const count = [...positions].filter(([p,location]) => adjacent.has(location) && hasType(record,p,1)).length;
  if (count) {
    const current = Number(skill.speed_or_damage), addend = 10 * count;
    (skill.sphere_damage ??= []).push({plate_id:5380,current,addend,result:current+addend});
    skill.speed_or_damage = current + addend;
  }
  return skill;
}

export function electroSphereTransitPairs(record, positions, state, waits, edges) {
  const pairs = new Set();
  if (!state?.attachments?.some(a => a.plate_id === 5380)) return pairs;
  const occupants = [...positions].filter(([p,point]) => field(point) && Number(waits.get(p)) > 0).map(([p]) => p);
  if (!occupants.length) return pairs;
  for (const [pokemon,point] of positions) {
    if (!(field(point) || point === 28+pokemon) || !sphereSources(record,positions,state,pokemon,5380,edges).length) continue;
    for (const through of occupants) if (through !== pokemon) pairs.add(pokemon*12+through);
  }
  return pairs;
}

// Aqua uses the current board before the move. A neighbor on either team is
// enough; additional neighbors/providers do not stack. Balloon precedence
// belongs to the owning MP calculation, not to team aura membership.
export function aquaSphereMpBonus(record, positions, state, pokemon, currentMp, edges) {
  if (!Number.isSafeInteger(currentMp) || currentMp < 0 || currentMp >= 3 || !field(positions.get(pokemon))
      || !state?.attachments?.some(a => a.plate_id === 5416)
      || !sphereSources(record,positions,state,pokemon,5416,edges).length) return 0;
  const point = positions.get(pokemon), adjacent = new Set();
  for (const [a,b] of edges) { if (a === point) adjacent.add(b); if (b === point) adjacent.add(a); }
  return [...positions].some(([p,location]) => adjacent.has(location) && hasType(record,p,8)) ? 1 : 0;
}

// Native membership is qualified by authored MP, independently of source
// charge and the current MP increment. MP3 holders still emit the aura.
function dragonLowMpRecipient(record,pokemon) {
  const figure=(record.players??[]).flatMap(p=>p.pokemons??[]).find(p=>p.pokemon_index===pokemon);
  return Number.isSafeInteger(figure?.mp) && figure.mp>=0 && figure.mp<=1;
}

export function dragonSphereMpBonus(record,positions,state,pokemon,currentMp,edges) {
  return Number.isSafeInteger(currentMp) && currentMp>=0 && currentMp<=1
    && sphereSources(record,positions,state,pokemon,5412,edges).length ? 1 : 0;
}

// Both declaration orders yield these compound outcomes: authored MP0/1
// with Aqua adjacency become MP2. The native internal instruction order
// was not observed; applying Aqua first reproduces the controlled outcomes.
export function sphereMovementMp(record,positions,state,pokemon,currentMp,edges) {
  const afterAqua=currentMp+aquaSphereMpBonus(record,positions,state,pokemon,currentMp,edges);
  return afterAqua+dragonSphereMpBonus(record,positions,state,pokemon,afterAqua,edges);
}

export function dragonSphereTransitPairs(record,positions,state,conditions,edges) {
  const pairs=new Set();
  if (!state?.attachments?.some(a=>a.plate_id===5412)) return pairs;
  const special=new Set(['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']);
  for (const [pokemon,point] of positions) {
    if (!field(point) || special.has(conditions.get(pokemon)) || !sphereSources(record,positions,state,pokemon,5412,edges).length) continue;
    for (const [through,location] of positions) if (through!==pokemon && field(location)) pairs.add(pokemon*12+through);
  }
  return pairs;
}

// These Sphere clauses restrict ability passage. Original type pairs differ;
// independent plate/base grants and source activation remain separate.
function sphereAbilityTransitBlocks(record,positions,state,edges,plateId,moverTypes) {
  const pairs=new Set();
  if (!state?.attachments?.some(a=>a.plate_id===plateId)) return pairs;
  const protectedFigures=[...positions].filter(([p,point])=>field(point) && sphereSources(record,positions,state,p,plateId,edges).length).map(([p])=>p);
  for (const [pokemon,point] of positions) {
    if (!field(point) || !moverTypes.some(type=>hasType(record,pokemon,type))) continue;
    for (const through of protectedFigures) if (Math.floor(pokemon/6)!==Math.floor(through/6)) pairs.add(pokemon*12+through);
  }
  return pairs;
}

export function darkSphereAbilityTransitBlocks(record,positions,state,edges) {
  return sphereAbilityTransitBlocks(record,positions,state,edges,5386,[15,3]);
}

export function stonySphereAbilityTransitBlocks(record,positions,state,edges) {
  return sphereAbilityTransitBlocks(record,positions,state,edges,5404,[12,17]);
}
