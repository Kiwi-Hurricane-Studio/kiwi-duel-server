// Fly1057: printed one/two-step landing range, anchored at the battle opponent.
// The preserved native 12-over-16 case advertises 21,17,22 in this order.
// Original legal histories and ally/enemy controls admit occupied intermediate
// points for Fly's second step. Destinations must remain empty.
import {effectKnockoutProtectionSources} from './effect-knockouts.mjs';
const conditionsThatTriggerKnockout=new Set(['poison','bad_poison','paralyze','sleep','burn','freeze','panic','melt']);

export function purpleJumpPlan(positions, winner, loser, skill, edges, context = {}) {
  const id=Number(skill?.id);
  if (![1057,1520].includes(id) || Number(skill.color) !== 2) return null;
  const from = positions.get(winner), over = positions.get(loser);
  const field = point => Number.isInteger(point) && point >= 0 && point < 28;
  const adjacent = point => edges.flatMap(([a,b]) => a === point ? [b] : b === point ? [a] : []).sort((a,b)=>a-b);
  if (!field(from) || !field(over) || !adjacent(from).includes(over)) throw new Error('invalid_purple_jump_battlers');
  const occupied = new Set([...positions.values()].filter(field));
  const transit=adjacent(over).filter(point=>point!==from);
  const first = transit.filter(point => !occupied.has(point));
  const targets = [...first];
  if(id===1057)for (const point of transit) for (const target of adjacent(point)) {
    if (target !== from && target !== over && !occupied.has(target) && !targets.includes(target)) targets.push(target);
  }
  const specialCondition=context.conditions?.get(loser);
  const protectionSources=id===1520&&conditionsThatTriggerKnockout.has(specialCondition)
    ?effectKnockoutProtectionSources(context.record,positions,context.conditions,loser,winner,context.turn,edges):[];
  return {skill:id, pokemon:winner, opponent:loser, from, over, targets,
    side:winner < 6 ? 'black' : 'white', extraBattle:id===1520,
    conditionalKnockouts:id===1520&&conditionsThatTriggerKnockout.has(specialCondition)&&!protectionSources.length?[loser]:[],
    protectionSources};
}
