import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createZTransactionState,selectZTransaction,advanceZTransaction,filterZPlayerContinuations,
  finishZNonbattleTurn,finishZBattle,applyZGaugeCause,copyZTransactionState} from './z-skill-transaction.mjs';
import {turnStartGaugeAward} from './z-gauge-rules.mjs';
const project=new URL('../',import.meta.url);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const j=path=>JSON.parse(readFileSync(path,'utf8'));
const digest=value=>hash(Buffer.from(JSON.stringify(value)));
let verifiedHashes=0,verifiedActions=0;
function load(folder){
  const dir=new URL(`docs/generated/z-skill-lifecycle-20260910/${folder}/`,project);
  const manifest=j(new URL('manifest.json',dir));
  assert.equal(manifest.complete,true);assert.equal(manifest.live_match_commands,0);
  assert.equal(manifest.device,'emulator-5554');assert.equal(manifest.avd,'ExecutionAtlas_API28_X86');
  assert.equal(hash(readFileSync(new URL(manifest.source_manifest,project))),manifest.source_manifest_sha256);
  const pairs=manifest.queries.map(query=>{
    const pair={query};
    for(const kind of ['request','response']){
      const bytes=readFileSync(new URL(query[`${kind}_file`],dir));
      assert.equal(hash(bytes),query[`${kind}_sha256`]);verifiedHashes++;
      pair[kind]=JSON.parse(bytes);
    }
    assert.equal(query.exit_code,0);
    assert.equal(digest(pair.request.record),query.record_sha256);
    return pair;
  });
  for(const entry of manifest.cases)for(const action of entry.actions){
    const legal=pairs.find(p=>p.query.sequence===action.legal_query_sequence);
    assert.ok(legal);assert.equal(legal.query.operation,'legal_moves');
    assert.ok(legal.response.legal_moves.some(candidate=>JSON.stringify(candidate)===JSON.stringify(action.move)));
    assert.equal(digest(legal.request.record),action.before_record_sha256);
    const next=structuredClone(legal.request.record);next.all_moves.push(action.move);
    assert.equal(digest(next),action.after_record_sha256);verifiedActions++;
  }
  return {manifest,pairs,get:(label,operation)=>{
    const result=pairs.find(({query})=>query.label===label&&query.operation===operation);
    assert.ok(result,`${folder}/${label}/${operation}`);return result;
  }};
}
const selection=load('native-selections'),followups=load('native-followups');
const gauges=status=>Object.fromEntries(status.z_gauge_conditions.map(({color,z_gauge})=>[color,z_gauge]));
const activeActors=status=>status.pokemon_conditions.filter(({marker})=>marker.z_state).map(({pokemon_index})=>pokemon_index);
const positions=status=>new Map(status.pokemon_conditions.map(({pokemon_index,index})=>[pokemon_index,index]));
function selectedState(entry){
  const before=selection.get(`${entry.name}-before`,'status');
  return selectZTransaction(createZTransactionState(),{action:entry.actions[0].move,
    legalActions:selection.get(`${entry.name}-choose`,'legal_moves').response.legal_moves,
    recordIndex:before.request.record.all_moves.length});
}
test('104 native lifecycle receipts verify208 hashes, source manifests and17 exact legal appends',()=>{
  assert.equal(selection.pairs.length,42);assert.equal(followups.pairs.length,62);
  assert.equal(verifiedHashes,208);assert.equal(verifiedActions,17);
});
for(const entry of selection.manifest.cases){
  test(`pure selection marker/restriction without gauge spending: ${entry.name}`,()=>{
    const before=selection.get(`${entry.name}-before`,'status').response.status;
    const after=selection.get(`${entry.name}-after`,'status').response.status;
    const state=selectedState(entry);
    assert.deepEqual(activeActors(before),[]);assert.deepEqual(activeActors(after),[state.active.pokemon]);
    assert.deepEqual(gauges(after),gauges(before));assert.equal(after.turn,before.turn);
    assert.deepEqual(selection.get(`${entry.name}-after`,'output_effects').response.effect_moves,[entry.actions[0].move]);
    const filtered=filterZPlayerContinuations(state,selection.get(`${entry.name}-before`,'legal_moves').response.legal_moves,positions(before));
    assert.deepEqual(filtered,selection.get(`${entry.name}-after`,'legal_moves').response.legal_moves);
  });
}
for(const entry of followups.manifest.cases){
  test(`pure ordered transaction and gauge causes: ${entry.name}`,()=>{
    let state=selectedState(selection.manifest.cases.find(c=>c.name===entry.name));
    let current=followups.get(`${entry.name}-selected`,'status').response.status;
    for(const action of entry.actions){
      const afterPair=followups.pairs.find(p=>p.query.operation==='status'&&p.query.record_sha256===action.after_record_sha256);
      assert.ok(afterPair);
      const after=afterPair.response.status;
      const effectPair=followups.pairs.find(p=>p.query.operation==='output_effects'&&p.query.record_sha256===action.after_record_sha256);
      const effects=effectPair.response.effect_moves.map(({value})=>value);
      let causes=[];
      if(action.move.value.type==='mp_move'){
        if(after.turn!==current.turn){const result=finishZNonbattleTurn(state,current.turn);state=result.state;causes=result.gaugeCauses;}
        else state=advanceZTransaction(state,{kind:'move_into_battle_choice',pokemon:state.active.pokemon});
      }else if(action.move.value.type==='declare_battle'){
        state=advanceZTransaction(state,{kind:'declare_battle',pokemon:action.move.value.from_pokemon,defender:action.move.value.to_pokemon});
      }else if(action.move.value.type==='spin'){
        const battle=effects.find(v=>v.type==='battle_result');
        assert.ok(battle);
        const knocked=effects.find(v=>v.type==='knockedout_move');
        const knockedPokemon=knocked?current.pokemon_conditions.find(p=>p.index===knocked.from).pokemon_index:null;
        // The three witnessed Z results are non-Miss; ordinary counterpart is
        // Miss1131. This test checks award classes, not Z wheel/color synthesis.
        assert.notEqual(battle.attack.skill,1131);assert.equal(battle.defence.skill,1131);
        const result=finishZBattle(state,{finalized:true,attackingSide:current.turn,zBattleOutcome:'win',
          attacker:battle.attack.pokemon,defender:battle.defence.pokemon,attackerColor:2,defenderColor:0,
          knockoutSide:knockedPokemon===null?null:knockedPokemon<6?'black':'white'});
        state=result.state;causes=result.gaugeCauses;
      }else assert.fail('unhandled native action in bounded fixture');
      if(after.turn!==current.turn)causes.push(turnStartGaugeAward(after.turn));
      let values=gauges(current);const actual=[];
      for(const cause of causes){const applied=applyZGaugeCause(values,cause);values=applied.gauges;actual.push(applied.value);}
      assert.deepEqual(actual,effects.filter(v=>v.type==='add_z_gauge'),'exact ordered native gauge events');
      assert.deepEqual(values,gauges(after));
      assert.deepEqual(activeActors(after),state.active?[state.active.pokemon]:[]);
      if(state.active?.phase==='battle_choice'){
        const legal=followups.pairs.find(p=>p.query.operation==='legal_moves'&&p.query.record_sha256===action.after_record_sha256).response.legal_moves;
        assert.deepEqual(filterZPlayerContinuations(state,legal,positions(after)),legal,'preserve native null decline in battle-choice phase');
      }
      current=after;
    }
    assert.equal(state.active,null);
  });
}
test('pure transaction rejects forged choices, wrong actors/phases and duplicate selection',()=>{
  const entry=selection.manifest.cases[0],action=entry.actions[0].move;
  const state=selectedState(entry),original=structuredClone(state);
  assert.throws(()=>selectZTransaction(state,{action,legalActions:[action],recordIndex:68}),/already_active/);
  for(const field of ['pokemon','dst_skill_id','speed_or_damage']){
    const wrong=structuredClone(action);wrong.value[field]++;
    assert.throws(()=>selectZTransaction(createZTransactionState(),{action:wrong,legalActions:[action],recordIndex:67}));
  }
  assert.throws(()=>advanceZTransaction(state,{kind:'declare_battle',pokemon:7,defender:0}),/wrong_z/);
  assert.throws(()=>advanceZTransaction(state,{kind:'declare_battle',pokemon:6,defender:7}),/target/);
  const resolving=advanceZTransaction(state,{kind:'declare_battle',pokemon:6,defender:0});
  assert.throws(()=>advanceZTransaction(resolving,{kind:'declare_battle',pokemon:6,defender:0}),/phase/);
  assert.throws(()=>finishZNonbattleTurn(resolving,'white'),/nonbattle/);
  assert.deepEqual(filterZPlayerContinuations(resolving,[action],new Map([[6,5]])),[]);
  assert.deepEqual(state,original,'inputs unchanged');
});
test('provisional battle cannot spend/reset; snapshot copies are independent and validate phases',()=>{
  const state=advanceZTransaction(selectedState(selection.manifest.cases[0]),{kind:'declare_battle',pokemon:6,defender:0});
  const facts={finalized:false,attackingSide:'white',attacker:6,defender:0,attackerColor:2,defenderColor:0};
  assert.deepEqual(finishZBattle(state,facts),{state,gaugeCauses:[]});
  assert.throws(()=>finishZBattle(state,{...facts,attacker:7}),/binding/);
  const snapshot=copyZTransactionState(state);snapshot.active.dst_skill_id++;
  assert.notEqual(snapshot.active.dst_skill_id,state.active.dst_skill_id);
  assert.throws(()=>copyZTransactionState({...state,schema:2}),/schema/);
  assert.throws(()=>copyZTransactionState({schema:1,active:{...state.active,battle:null}}),/binding/);
});
test('cause sink preserves zero events and overrides final attacker plus Miss without collapsing KO/new-turn',()=>{
  let state=selectedState(selection.manifest.cases[3]);
  state=advanceZTransaction(state,{kind:'declare_battle',pokemon:0,defender:6});
  const {gaugeCauses}=finishZBattle(state,{finalized:true,attackingSide:'black',attacker:0,defender:6,attackerColor:0,defenderColor:0,knockoutSide:'black',zBattleOutcome:'win'});
  // This is an algebra/guard test, not a native Z-losing/Miss joint witness.
  gaugeCauses.push(turnStartGaugeAward('white'));
  let gauge={black:100,white:100};const values=[];
  for(const cause of gaugeCauses){const next=applyZGaugeCause(gauge,cause);values.push(next.value);gauge=next.gauges;}
  assert.equal(values.length,3);assert.equal(values[0].black,0);assert.equal(values[1].black,-100);
  assert.equal(values[2].black,0);assert.deepEqual(gauge,{black:0,white:100});
  assert.throws(()=>applyZGaugeCause({black:NaN,white:100},gaugeCauses[0]),/gauges/);
  assert.throws(()=>applyZGaugeCause(gauge,{cause:'bad',deltas:{black:0,white:0},absolute:{green:0}}),/override/);
});
