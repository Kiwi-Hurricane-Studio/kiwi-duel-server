import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {CustomMatchService} from './custom-match-engine.mjs';

const root = new URL('../docs/generated/z-skill-lifecycle-20260910/',import.meta.url);
const hash = (bytes)=>createHash('sha256').update(bytes).digest('hex');
const folders = ['native-turn-field-prefixes','native-turn-position-branches','native-turn-mirrored','native-turn-crossings'];
const fixtures = [];
let queryCount=0,actionCount=0;
for(const folder of folders){
  const directory=new URL(`${folder}/`,root);
  const manifest=JSON.parse(readFileSync(new URL('manifest.json',directory)));
  assert.equal(manifest.complete,true);
  assert.equal(manifest.live_match_commands,0);
  assert.equal(manifest.device,'emulator-5554');
  assert.equal(manifest.avd,'ExecutionAtlas_API28_X86');
  const source=manifest.source_file??manifest.source_manifest;
  assert.ok(source);
  assert.equal(hash(readFileSync(new URL(`../${source}`,import.meta.url))),manifest.source_sha256??manifest.source_manifest_sha256);
  const pairs=new Map();
  for(const query of manifest.queries){
    const pair={};
    for(const kind of ['request','response']){
      const bytes=readFileSync(new URL(query[`${kind}_file`],directory));
      assert.equal(hash(bytes),query[`${kind}_sha256`]);
      pair[kind]=JSON.parse(bytes);
    }
    assert.equal(hash(JSON.stringify(pair.request.record)),query.record_sha256);
    pairs.set(query.sequence,pair);
    queryCount++;
  }
  for(const action of manifest.cases.flatMap(entry=>entry.actions??[])){
    const pair=pairs.get(action.legal_query_sequence);
    assert.ok(pair);
    assert.equal(hash(JSON.stringify(pair.request.record)),action.before_record_sha256);
    assert.ok(pair.response.legal_moves.some(move=>JSON.stringify(move)===JSON.stringify(action.move)));
    const record=structuredClone(pair.request.record);
    record.all_moves.push(action.move);
    assert.equal(hash(JSON.stringify(record)),action.after_record_sha256);
    actionCount++;
  }
  for(const query of manifest.queries.filter(row=>row.operation==='status')){
    const effectQuery=manifest.queries.find(row=>row.label===query.label&&row.record_sha256===query.record_sha256&&row.operation==='output_effects');
    if(!effectQuery)continue;
    const effects=pairs.get(effectQuery.sequence).response.effect_moves.map(row=>row.value);
    if(!effects.some(value=>value.type==='turn_end'))continue;
    fixtures.push({folder,label:query.label,...pairs.get(query.sequence),effects});
  }
}

test('turn-position receipts verify all128 queries,32 appends and31 completed native turns',()=>{
  assert.equal(queryCount,128);
  assert.equal(actionCount,32);
  assert.equal(fixtures.length,31);
});

for(const fixture of fixtures){
  test(`native geometry turn gauge full prefix: ${fixture.folder}/${fixture.label}`,t=>{
    const errors=[];
    const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0});
    service.playOpponentTurn=()=>{};
    service.resolveBattle=()=>assert.fail('these geometry contrasts contain no battle spin');
    const match=service.createMatch('native-turn-geometry');
    match.phase='started';
    match.socket={destroyed:false,write:()=>{},destroy:error=>errors.push(error.message)};
    t.after(()=>{match.phase='finished';});
    assert.ok(['black','white'].includes(fixture.request.record.first_player));
    // This is an authored match-start field, not a later native status snapshot.
    match.record.first_player=fixture.request.record.first_player;
    match.turn=match.record.first_player;
    for(const player of match.record.players){
      const original=fixture.request.record.players.find(row=>row.color===player.color);
      player.pokemons=structuredClone(original.pokemons);
      player.plates=[...original.plates];
    }
    let lastStart=0;
    for(const move of fixture.request.record.all_moves){
      assert.ok(['mp_move','null_move'].includes(move.value.type),'native geometry prefixes are real nonbattle moves/declines');
      lastStart=match.record.all_moves.length;
      service.acceptPlayerMove(match,move,move.selective_side);
      assert.deepEqual(errors,[],'full native prefix must remain legal');
    }
    const native=fixture.response.status;
    assert.equal(match.turn,native.turn);
    for(const figure of native.pokemon_conditions){
      assert.equal(match.positions.get(figure.pokemon_index),figure.index);
      assert.equal(match.waits.get(figure.pokemon_index),figure.wait);
    }
    assert.deepEqual(match.zGauge,Object.fromEntries(native.z_gauge_conditions.map(row=>[row.color,row.z_gauge])));
    assert.deepEqual(match.record.all_moves.slice(lastStart).filter(row=>row.value.type==='add_z_gauge').map(row=>row.value),
      fixture.effects.filter(value=>value.type==='add_z_gauge'),'exact final-turn emitted delta and absolute result');
  });
}
