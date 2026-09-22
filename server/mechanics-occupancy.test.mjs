import test from 'node:test';
import assert from 'node:assert/strict';
import {CustomMatchService, customMatchTestHooks as rules, customMatchContract} from './custom-match-engine.mjs';

// Independent contract: ordinary MP paths end on vacant points. Original
// legal-action sets are retained in battle-route-20260909/full-heal-native-query;
// combat is a separate declaration against an adjacent opponent.
const move = (side, route, type = 'mp_move') => ({selective_side: side, value: {type, route}});
function fixture(side = 'black') {
  const service = new CustomMatchService({port: 0, clockSource: () => 0});
  const match = service.createMatch('isolated-occupancy-' + side);
  match.phase = 'started'; match.turn = side;
  match.turns.black = 1; match.turns.white = 1;
  const actor = side === 'black' ? 0 : 6, enemy = side === 'black' ? 6 : 0;
  const from = side === 'black' ? 21 : 6, to = side === 'black' ? 17 : 10;
  match.positions.set(actor, from); match.positions.set(enemy, to);
  return {service, match, actor, enemy, from, to};
}
const observable = match => JSON.stringify({positions: [...match.positions], moves: match.record.all_moves,
  conditions: [...match.conditions], waits: [...match.waits], turn: match.turn,
  plates: match.plateState, pending: match.pendingBattles, turns: match.turns});

for (const side of ['black', 'white']) {
  test(`${side}: real player action refuses occupied endpoint without mutation`, () => {
    const {service, match, from, to} = fixture(side);
    const before = observable(match), rejected = [];
    service.rejectPlayerMove = (_, reason) => rejected.push(reason);
    try {
      service.acceptPlayerMove(match, move(side, [from, to]), side);
      assert.equal(observable(match), before);
      assert.deepEqual(rejected, ['illegal_player_movement']);
    } finally { match.phase = 'finished'; }
  });
  for (const type of ['mp_move', 'route_move']) test(`${side}: ${type} cannot relocate onto another figure`, () => {
    const {match, from, to} = fixture(side), before = [...match.positions];
    rules.applyPositionMove(match, move(side, [from, to], type));
    assert.deepEqual([...match.positions], before);
  });
  test(`${side}: bench entry cannot finish on occupied entry`, () => {
    const {match, actor, enemy} = fixture(side);
    const bench = 28 + actor, entry = side === 'black' ? 21 : 0;
    match.positions.set(actor, bench); match.positions.set(enemy, entry);
    assert.equal(rules.validateMovement(match, side, move(side, [bench, entry])), false);
  });
  test(`${side}: every ordinary route avoids all occupied destinations and transit points`, () => {
    for (const [from, to] of customMatchContract.fieldEdges.flatMap(([a,b]) => [[a,b],[b,a]])) {
      const {match, actor, enemy} = fixture(side);
      match.positions.set(actor, from); match.positions.set(enemy, to);
      const occupied = new Set(match.positions.values());
      const routes = rules.legalRoutes(match, side).filter(action => action.value.route[0] === from);
      assert(!routes.some(action => action.value.route.slice(1).some(point => occupied.has(point))), `${from} -> ${to}`);
      assert.equal(rules.validateBattleDeclaration(match, side, {selective_side: side,
        value: {type: 'declare_battle', from_pokemon: actor, to_pokemon: enemy}}), true, 'adjacent attack remains available');
    }
  });
  test(`${side}: explicit allied swap preserves unique occupancy`, () => {
    const {match, actor} = fixture(side), other = actor + 1;
    const before = [match.positions.get(actor), match.positions.get(other)];
    const action = {selective_side: side, value: {type: 'declare_plate', plate_id: 5023,
      value: {type: 'swap_move', pokemons: [actor, other]}}};
    assert.equal(rules.validatePlateMove(match, side, action), true);
    rules.applyPositionMove(match, action);
    assert.deepEqual([match.positions.get(actor), match.positions.get(other)], [28+actor,before[0]]);
    assert.equal(new Set(match.positions.values()).size, match.positions.size);
  });
  test(`${side}: malformed swaps cannot create phantom figures or undefined positions`, () => {
    for (const invalid of [-1,12,999,NaN,Infinity,1.5]) {
      const {service,match,actor}=fixture(side),rejections=[];
      // PlayGame initializes this before any network plate action. Include it
      // in the baseline so rejection must preserve the full established state.
      rules.ensurePlateState(match);
      const before=observable(match);
      const action={selective_side:side,value:{type:'declare_plate',plate_id:5023,value:{type:'swap_move',pokemons:[actor,invalid]}}};
      service.rejectPlayerMove=(_,reason)=>rejections.push(reason);
      service.acceptPlayerMove(match,action,side);
      assert.equal(rejections.length,1);assert.equal(observable(match),before);
      // Also protect the internal relocation primitive from malformed replay
      // input, even when it is called outside the player validation path.
      rules.applyPositionMove(match,action);
      assert.equal(observable(match),before);
    }
  });
  for(const condition of ['sleep','freeze','melt']) test(`${side}: ${condition} figures cannot initiate movement or battle but remain valid opponents`, () => {
    const {service,match,actor,enemy,from}=fixture(side);
    match.conditions.set(actor,condition);
    assert(!rules.legalRoutes(match,side).some(action=>action.value.route[0]===from));
    const attack={selective_side:side,value:{type:'declare_battle',from_pokemon:actor,to_pokemon:enemy}};
    assert.equal(rules.validateBattleDeclaration(match,side,attack),false);
    const before=observable(match),rejections=[];
    service.rejectPlayerMove=(_,reason)=>rejections.push(reason);
    const routes=customMatchContract.fieldEdges.flatMap(([a,b])=>[[a,b],[b,a]]).filter(([a,b])=>a===from&&b!==match.positions.get(enemy));
    assert(routes.length>0);
    service.acceptPlayerMove(match,move(side,routes[0]),side);
    assert.deepEqual(rejections,['illegal_player_movement']);assert.equal(observable(match),before);
    service.acceptPlayerMove(match,attack,side);
    assert.equal(rejections.length,2);assert.equal(observable(match),before);
    const other=side==='black'?'white':'black';match.turn=other;
    assert.equal(rules.validateBattleDeclaration(match,other,{selective_side:other,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:actor}}),true);
  });
}
