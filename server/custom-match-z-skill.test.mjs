import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CustomMatchService } from './custom-match-engine.mjs';

// Authentic native legal receipts prove acceptance only here. No consume,
// temporary-form lifetime, turn change or follow-up effect is guessed.
const archive = new URL('../docs/generated/z-gauge-rules-20260910/native-cap-exact-routes/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, archive), 'utf8'));
const manifest = read('manifest.json');
assert.equal(manifest.complete, true);
assert.equal(manifest.source_unchanged, true);
function verified(query, directory = archive) {
  const pair = {};
  for (const kind of ['request', 'response']) {
    const bytes = readFileSync(new URL(query[`${kind}_file`], directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), query[`${kind}_sha256`]);
    pair[kind] = JSON.parse(bytes);
  }
  return pair;
}
const cases = new Map();
for (const query of manifest.queries.filter(({operation})=>operation === 'legal_moves')) {
  const pair = verified(query);
  const actions = pair.response.legal_moves.filter(({value})=>value.type === 'z_skill');
  if (!actions.length || cases.has(query.record_sha256)) continue;
  const statusQuery = manifest.queries.find((entry)=>entry.record_sha256 === query.record_sha256 && entry.operation === 'status');
  assert.ok(statusQuery, 'each chosen legal receipt has matching native status');
  cases.set(query.record_sha256, {query, ...pair, actions, status:verified(statusQuery).response.status});
}

function fullNativePrefix(t, fixture) {
  const errors = [];
  const spinUnits = [];
  let declaration;
  let lastBattleGaugeMoves = [];
  for (const action of fixture.request.record.all_moves) {
    if (action.value.type === 'declare_battle') declaration = action;
    if (action.value.type === 'spin') {
      assert.ok(declaration);
      for (const pokemon of [declaration.value.from_pokemon,declaration.value.to_pokemon]) {
        spinUnits.push(action.value.spins.find((row)=>row.pokemon === pokemon).results[0].num);
      }
    }
  }
  const service = new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,
    spinUnitSource:(maximum)=>{const value=spinUnits.shift();assert.ok(Number.isInteger(value)&&value>=0&&value<maximum);return value;}});
  let beforeTurnOutcome = null;
  const resolveOutcome = service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome = (...args)=>{
    const result = resolveOutcome(...args);
    beforeTurnOutcome = {waits:new Map(args[0].waits),positions:new Map(args[0].positions)};
    return result;
  };
  const completeOutcome = service.completeBattleResolution.bind(service);
  service.completeBattleResolution = (...args)=>{
    beforeTurnOutcome = {waits:new Map(args[0].waits),positions:new Map(args[0].positions)};
    return completeOutcome(...args);
  };
  service.playOpponentTurn = ()=>{};
  service.resolveBattle = ()=>{};
  service.schedulePendingKnockouts = ()=>{};
  const match = service.createMatch('isolated-authentic-z-choice');
  match.phase = 'started';
  match.socket = {destroyed:false,write:()=>{},destroy:(error)=>errors.push(error.message)};
  t.after(()=>{match.phase='finished';});
  for (const player of match.record.players) {
    const native = fixture.request.record.players.find(({color})=>color === player.color);
    player.pokemons = structuredClone(native.pokemons);
    player.plates = [...native.plates];
  }
  declaration = null;
  for (const action of fixture.request.record.all_moves) {
    if (action.value.type === 'spin') {
      assert.ok(declaration);
      const beforeSpin = match.record.all_moves.length;
      service.performBattleSpin(match,declaration.value.from_pokemon,declaration.value.to_pokemon,declaration.selective_side);
      lastBattleGaugeMoves = match.record.all_moves.slice(beforeSpin).filter(({value})=>value.type === 'add_z_gauge').map(({value})=>value);
      declaration = null;
    } else if (action.selective_side === 'both' && ['knockedout_move','spot_move'].includes(action.value.type)) {
      assert.equal(typeof service.performPendingKnockouts,'function','native system KO continuation must have a real authoritative handler');
      const beforeContinuation = match.record.all_moves.length;
      assert.equal(service.performPendingKnockouts(match,match.pendingKnockouts,action),true,
        'exact native system continuation must be accepted');
      lastBattleGaugeMoves = match.record.all_moves.slice(beforeContinuation).filter(({value})=>value.type === 'add_z_gauge').map(({value})=>value);
    } else {
      service.acceptPlayerMove(match,action,action.selective_side);
      if (action.value.type === 'declare_battle') declaration = action;
    }
    assert.deepEqual(errors,[],'full original legal prefix must be accepted before Z assertion');
  }
  assert.equal(match.turn,fixture.status.turn);
  for (const native of fixture.status.pokemon_conditions) {
    assert.equal(match.positions.get(native.pokemon_index),native.index,'native prefix field position');
    assert.equal(match.waits.get(native.pokemon_index),native.wait,`native prefix wait pokemon${native.pokemon_index}`);
    assert.equal(match.conditions.get(native.pokemon_index),native.marker.circle,'native prefix condition');
  }
  assert.deepEqual(match.zGauge,Object.fromEntries(fixture.status.z_gauge_conditions.map(({color,z_gauge})=>[color,z_gauge])));
  assert.equal(spinUnits.length,0);
  if (fixture.effectMoves) {
    assert.ok(beforeTurnOutcome,'native spin must resolve a real outcome before turn completion');
    const nativeAssignedWait = new Map();
    for (const {value} of fixture.effectMoves) {
      if (value.type === 'wait') for (const pokemon of value.pokemons) nativeAssignedWait.set(pokemon,value.duration);
    }
    for (const [pokemon,duration] of nativeAssignedWait) {
      assert.equal(beforeTurnOutcome.waits.get(pokemon),duration,`native pre-turn effect Wait pokemon${pokemon}`);
    }
    assert.deepEqual(lastBattleGaugeMoves,fixture.effectMoves.filter(({value})=>value.type === 'add_z_gauge').map(({value})=>value),
      'preserve every ordered KO, final battle and next-turn gauge event');
  }
  return {service,match,errors};
}

function verifiedRockArchive(folder, expectedQueries, expectedActions) {
  const directory = new URL(`../docs/generated/z-skill-lifecycle-20260910/${folder}/`,import.meta.url);
  const data = JSON.parse(readFileSync(new URL('manifest.json',directory),'utf8'));
  assert.equal(data.complete,true);
  if (data.source_file) assert.notEqual(data.source_unchanged,false);
  assert.equal(data.live_match_commands,0);
  assert.equal(data.device,'emulator-5554');
  assert.equal(data.avd,'ExecutionAtlas_API28_X86');
  assert.equal(data.queries.length,expectedQueries);
  const sourcePath = data.source_file ?? data.source_manifest;
  assert.ok(sourcePath);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`../${sourcePath}`,import.meta.url))).digest('hex'),data.source_sha256 ?? data.source_manifest_sha256);
  const pairs = new Map(data.queries.map(query=>{
    const pair = verified(query,directory);
    assert.equal(createHash('sha256').update(JSON.stringify(pair.request.record)).digest('hex'),query.record_sha256);
    return [query.sequence,pair];
  }));
  const actions = data.cases.flatMap(entry=>entry.actions);
  assert.equal(actions.length,expectedActions);
  for (const action of actions) {
    const pair = pairs.get(action.legal_query_sequence);
    assert.ok(pair);
    assert.equal(createHash('sha256').update(JSON.stringify(pair.request.record)).digest('hex'),action.before_record_sha256);
    assert.ok(pair.response.legal_moves.some(move=>JSON.stringify(move)===JSON.stringify(action.move)),'every appended action was an exact native legal alternative');
    const record = structuredClone(pair.request.record);
    record.all_moves.push(action.move);
    assert.equal(createHash('sha256').update(JSON.stringify(record)).digest('hex'),action.after_record_sha256);
  }
  return {data,directory};
}

test('native skill1140 adjacent win: full legal prefix, opposing-only targets and ordered gauges',t=>{
  const {data,directory} = verifiedRockArchive('native-rock-adjacent-win',25,13);
  const statusQuery = data.queries.find(query=>query.label==='adjacent-win-first-resolved0'&&query.operation==='status');
  const effectQuery = data.queries.find(query=>query.record_sha256===statusQuery.record_sha256&&query.operation==='output_effects');
  const pair = verified(statusQuery,directory);
  const effects = verified(effectQuery,directory).response.effect_moves;
  assert.deepEqual(effects.filter(({value})=>value.type==='wait').map(({value})=>value),[{duration:3,pokemons:[0,1],type:'wait'}]);
  const {match} = fullNativePrefix(t,{request:pair.request,status:pair.response.status,effectMoves:effects});
  assert.equal(match.waits.get(0),2);
  assert.equal(match.waits.get(1),2);
  assert.equal(match.waits.get(7),0,'friendly figure next to battle opponent is not a Rock Slide target');
});

for (const [folder,label,queries,actions] of [
  ['native-rock-adjacent-blue','adjacent-blue-first-resolved0',25,13],
  ['native-rock-adjacent-rehit','adjacent-draw-rehit-first-resolved0',41,17],
  ['native-rock-adjacent-rehit','adjacent-draw-rehit-second-resolved0',41,17],
  ['native-rock-adjacent-rehit','adjacent-draw-rehit-second-resolved1',41,17],
  ['native-rock-single-rehit','single-draw-rehit-second-resolved0',37,16],
  ['native-full-center','full-center-resolved0',19,7],
  ['native-rock-three-ko','three-ko-first-resolved0',52,22],
  ['native-rock-three-ko','three-ko-second-resolved0',52,22],
  ['native-rock-three-ko','three-ko-second-resolved1',52,22],
  ['native-rock-three-ko','three-ko-second-resolved2',52,22],
  ['native-rock-three-ko','three-ko-second-resolved3',52,22],
]) {
  test(`native skill1140 full-prefix phase: ${label}`,t=>{
    const {data,directory} = verifiedRockArchive(folder,queries,actions);
    const statusQuery = data.queries.find(query=>query.label===label&&query.operation==='status');
    assert.ok(statusQuery);
    const effectQuery = data.queries.find(query=>query.record_sha256===statusQuery.record_sha256&&query.operation==='output_effects');
    const pair = verified(statusQuery,directory);
    const effects = verified(effectQuery,directory).response.effect_moves;
    const {match} = fullNativePrefix(t,{request:pair.request,status:pair.response.status,effectMoves:effects});
    assert.equal(Boolean(match.pendingKnockouts),
      (folder==='native-rock-adjacent-rehit'&&label.endsWith('second-resolved0'))
      || (folder==='native-rock-three-ko'&&['three-ko-second-resolved0','three-ko-second-resolved1','three-ko-second-resolved2'].includes(label)));
  });
}

test('native cap Z acceptance fixtures have four distinct coherent prefixes and no invented Z continuation',()=>{
  assert.equal(cases.size,4);
  for (const fixture of cases.values()) {
    assert.equal(fixture.request.record.all_moves.some(({value})=>value.type === 'z_skill'),false);
    assert.equal(fixture.status.z_gauge_conditions.find(({color})=>color===fixture.status.turn).z_gauge,100);
  }
});

for (const fixture of cases.values()) {
  for (const action of fixture.actions) {
    test(`native legal Z acceptance ${fixture.query.label}: ${action.selective_side}/${action.value.pokemon}/${action.value.dst_skill_id}`,t=>{
      const {service,match,errors} = fullNativePrefix(t,fixture);
      const preceding = match.record.all_moves.length;
      service.acceptPlayerMove(match,action,action.selective_side);
      assert.deepEqual(errors,[],'an exact native-advertised Z action must not be rejected as unsupported');
      assert.ok(match.record.all_moves.length>preceding,'accepted Z choice must enter authoritative record');
      assert.deepEqual(match.record.all_moves[preceding].value,action.value,'preserve original Z payload');
      // Native post-choice status/effects are not available in this archive.
      // Consumption and phase assertions belong to the forthcoming receipts.
    });
  }
}

const neutralArchive = new URL('../docs/generated/z-gauge-rules-20260910/native-neutral-matrix/', import.meta.url);
const neutralManifest = JSON.parse(readFileSync(new URL('manifest.json', neutralArchive), 'utf8'));
assert.equal(neutralManifest.complete, true);
assert.equal(neutralManifest.source_unchanged, true);
for (const entry of neutralManifest.cases) {
  const query = neutralManifest.queries.find(q=>q.operation === 'status' && q.label === `${entry.name}-after-spin`);
  assert.ok(query);
  const pair = verified(query, neutralArchive);
  const effectQuery = neutralManifest.queries.find(q=>q.operation === 'output_effects' && q.record_sha256 === query.record_sha256);
  assert.ok(effectQuery);
  const effects = verified(effectQuery,neutralArchive).response.effect_moves;
  test(`native skill1140 wait full-prefix control: ${entry.name}`,t=>{
    fullNativePrefix(t,{request:pair.request,status:pair.response.status,effectMoves:effects});
  });
}
