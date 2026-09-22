import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {CustomMatchService,customMatchPrimitives,customMatchTestHooks as hooks} from './custom-match-engine.mjs';

const directory=new URL('../docs/generated/z-skill-lifecycle-20260910/native-followups/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',directory),'utf8'));
assert.equal(manifest.complete,true);
assert.equal(manifest.live_match_commands,0);
assert.equal(manifest.device,'emulator-5554');
assert.equal(manifest.avd,'ExecutionAtlas_API28_X86');
const hash=value=>createHash('sha256').update(value).digest('hex');
const verified=new Map(manifest.queries.map(query=>{
  const pair={query};
  for(const kind of ['request','response']){
    assert.ok(!/[\\/]/.test(query[kind+'_file']));
    const bytes=readFileSync(new URL(query[kind+'_file'],directory));
    assert.equal(hash(bytes),query[kind+'_sha256']);pair[kind]=JSON.parse(bytes);
  }
  assert.equal(hash(JSON.stringify(pair.request.record)),query.record_sha256);
  return [query.sequence,pair];
}));
function checkpoint(suffix){
  const query=manifest.queries.find(q=>q.label==='white-field-purple1717-'+suffix&&q.operation==='status');
  assert.ok(query,suffix);
  const pair=verified.get(query.sequence);
  const effects=manifest.queries.find(q=>q.record_sha256===query.record_sha256&&q.operation==='output_effects');
  return {...pair,effects:verified.get(effects.sequence).response.effect_moves};
}

// Full native-legal history is sent through the production validator and spin
// resolver. No final position, Wait, gauge or Z-state snapshot is hydrated.
async function replay(t,record){
  const errors=[],units=[],writes=[];
  let declaration;
  for(const action of record.all_moves){
    if(action.value.type==='declare_battle')declaration=action;
    if(action.value.type==='spin')for(const actor of [declaration.value.from_pokemon,declaration.value.to_pokemon]){
      units.push(action.value.spins.find(row=>row.pokemon===actor).results[0].num);
    }
  }
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,
    spinUnitSource:maximum=>{const n=units.shift();assert.ok(Number.isInteger(n)&&n>=0&&n<maximum);return n;}});
  service.playOpponentTurn=()=>{};service.resolveBattle=()=>{};service.schedulePendingKnockouts=()=>{};
  const match=service.createMatch('private-z1717-full-prefix');match.phase='started';
  match.socket={write:line=>writes.push(line),destroy:error=>errors.push(error.message)};
  t.after(()=>{match.phase='finished';});
  for(const player of match.record.players){
    const source=record.players.find(row=>row.color===player.color);
    player.pokemons=structuredClone(source.pokemons);player.plates=[...source.plates];
  }
  const definitions=structuredClone(match.record.players);
  let beforeTurn,lastOutcome,lastBattleGauge=[],lastState;
  const finishSpin=service.finishBattleSpin.bind(service);
  service.finishBattleSpin=(...args)=>{lastState=structuredClone(args[1]);return finishSpin(...args);};
  const original=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{
    // Resolution mutates the validated transaction projection before commit.
    // Observe that actual argument, not the still-uncommitted live match.
    const result=original(...args);lastOutcome=result;beforeTurn=new Map(args[0].waits);return result;
  };
  declaration=null;
  for(const action of record.all_moves){
    if(action.value.type==='spin'){
      const before=match.record.all_moves.length;
      CustomMatchService.prototype.resolveBattle.call(service,match,declaration);
      const deadline=Date.now()+2000;
      while(!match.record.all_moves.slice(before).some(a=>a.value.type==='spin')){
        assert.ok(Date.now()<deadline,'production scheduled spin completed');
        await new Promise(resolve=>setTimeout(resolve,1));
      }
      lastBattleGauge=match.record.all_moves.slice(before).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value);
      declaration=null;
    }else if(action.selective_side==='both'&&['spot_move','knockedout_move'].includes(action.value.type)){
      assert.equal(service.performPendingKnockouts(match,match.pendingKnockouts,action),true);
    }else{
      service.acceptPlayerMove(match,action,action.selective_side);
      if(action.value.type==='declare_battle')declaration=action;
    }
    assert.deepEqual(errors,[],`production rejects native ${action.value.type}`);
  }
  assert.equal(units.length,0);assert.deepEqual(match.record.players,definitions,'ordinary record wheels remain immutable');
  return {service,match,errors,writes,beforeTurn,lastOutcome,lastBattleGauge,lastState};
}
function compareState(match,status){
  assert.equal(match.turn,status.turn);
  assert.deepEqual(match.zGauge,Object.fromEntries(status.z_gauge_conditions.map(row=>[row.color,row.z_gauge])));
  for(const row of status.pokemon_conditions){
    assert.equal(match.positions.get(row.pokemon_index),row.index,'native figure position');
    assert.equal(match.waits.get(row.pokemon_index),row.wait,'native Wait');
    assert.equal(match.conditions.get(row.pokemon_index),row.marker.circle,'native condition');
    assert.equal(hooks.ensureZState(match).active?.pokemon===row.pokemon_index,Boolean(row.marker.z_state),'native Z marker');
  }
}
for(const [suffix,phase]of [['selected','selected'],['after-route0','battle_choice'],['after-battle','resolving'],['after-auto0',null]]){
  test('integrated1717 full native prefix: '+suffix,async t=>{
    const fixture=checkpoint(suffix),run=await replay(t,fixture.request.record);
    compareState(run.match,fixture.response.status);
    const state=customMatchPrimitives.makePlayGame(run.match).ZState;
    assert.equal(state.schema,1);assert.equal(state.match_id,run.match.record.id);
    assert.equal(state.record_move_count,run.match.record.all_moves.length);
    assert.equal(state.active?.phase??null,phase);
    assert.equal(state.figures[1].pokemons[0],1150);
    if(phase){
      const selected=run.match.record.all_moves[state.active.selected_record_index];
      assert.equal(selected.value.type,'z_skill');assert.equal(selected.value.pokemon,6);
      assert.deepEqual(hooks.selectedSkill(run.match,6,95),{id:1717,range:96,speed_or_damage:4,color:2,format:1,z_skill:true});
      assert.deepEqual(state.legal_actions,[],'active transaction does not advertise another Z');
    }else{
      assert.equal(run.beforeTurn.get(0),9);assert.equal(run.match.waits.get(0),8);
      assert.equal(run.lastOutcome.attackerSkill.id,1717);assert.equal(run.lastOutcome.attackerSkill.color,2);
      assert.equal(hooks.selectedSkill(run.match,6,95).id,1131,'ordinary wheel restores at finalization');
      assert.deepEqual(run.lastBattleGauge,fixture.effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),
        'ordered final-reset and retained capped-zero turn award match native');
    }
  });
}
async function beforeSelection(t){
  const record=structuredClone(checkpoint('selected').request.record);
  const declaration=record.all_moves.pop();assert.equal(declaration.value.type,'z_skill');
  return {...await replay(t,record),declaration};
}
test('integrated1717 normal server choices bind exact power, actor, deck and phase',async t=>{
  const {match,service,errors,declaration}=await beforeSelection(t);
  const state=customMatchPrimitives.makePlayGame(match).ZState;
  assert.ok(state.legal_actions.some(a=>JSON.stringify(a.value)===JSON.stringify(declaration.value)));
  for(const change of [{speed_or_damage:40},{pokemon:0},{dst_skill_id:1692},{injected:true}]){
    const before=match.record.all_moves.length,gauges=structuredClone(match.zGauge);
    service.acceptPlayerMove(match,{...declaration,value:{...declaration.value,...change}},'white');
    assert.equal(errors.pop(),'illegal_player_z_skill');assert.equal(match.record.all_moves.length,before);
    assert.deepEqual(match.zGauge,gauges);assert.equal(hooks.ensureZState(match).active,null);
  }
  service.acceptPlayerMove(match,declaration,'white');assert.deepEqual(errors,[]);
  const accepted=match.record.all_moves.length;
  service.acceptPlayerMove(match,declaration,'white');assert.equal(errors.pop(),'illegal_player_z_skill');
  for(const value of [{type:'null_move'},{type:'declare_turn_end'},
    {type:'declare_plate',plate_id:5022,value:{type:'select_pokemon',pokemon:6}},
    {type:'mp_move',route:[35,6]}, {type:'declare_battle',from_pokemon:7,to_pokemon:0}]){
    service.acceptPlayerMove(match,{selective_side:'white',value},'white');
    // This fixture has no available5022 copy; proposal validation rejects that
    // plate before the Z continuation gate. Other proposals reach that gate.
    const rejection=value.type==='declare_plate'?'completion_record_invalid':'z_continuation_required';
    assert.equal(errors.pop(),rejection);assert.equal(match.record.all_moves.length,accepted);
  }
  const snapshot=customMatchPrimitives.makePlayGame(match).ZState;
  snapshot.active.speed_or_damage=999;snapshot.figures[0].pokemons[0]=-1;
  assert.equal(hooks.ensureZState(match).active.speed_or_damage,4);
  assert.equal(customMatchPrimitives.makePlayGame(match).ZState.figures[0].pokemons[0],1150);
});
test('integrated1717 moved battle choice may decline without spending gauge; wrong actor and second movement rejected',async t=>{
  const {match,service,errors}=await replay(t,checkpoint('after-route0').request.record);
  const before=structuredClone(match.zGauge),length=match.record.all_moves.length;
  service.acceptPlayerMove(match,{selective_side:'white',value:{type:'mp_move',route:[11,6]}},'white');
  assert.equal(errors.pop(),'z_continuation_required');assert.equal(match.record.all_moves.length,length);
  service.acceptPlayerMove(match,{selective_side:'white',value:{type:'null_move'}},'white');
  assert.deepEqual(errors,[]);assert.equal(match.turn,'black');assert.equal(hooks.ensureZState(match).active,null);
  assert.equal(match.zGauge.white,before.white,'nonbattle expiry does not consume');
  assert.equal(hooks.selectedSkill(match,6,95).id,1131);
});
test('integrated1717 snapshots follow the complete authoritative batch',async t=>{
  const {match,service,writes,declaration}=await beforeSelection(t);
  await new Promise(resolve=>setImmediate(resolve));writes.length=0;
  service.acceptPlayerMove(match,declaration,'white');
  assert.equal(writes.some(line=>line.includes('z_state ')),false,'not published mid-transition');
  await new Promise(resolve=>setImmediate(resolve));
  const snapshots=writes.filter(line=>line.includes('z_state '));assert.equal(snapshots.length,1);
  const state=JSON.parse(snapshots[0].slice(snapshots[0].indexOf('z_state ')+8));
  assert.equal(state.record_move_count,match.record.all_moves.length);assert.equal(state.active.phase,'selected');
  assert.equal(state.active.selected_record_index,match.record.all_moves.length-1);
});
test('integrated1717 fails closed on substituted figure binding or missing resumed transaction',async t=>{
  const {match}=await replay(t,checkpoint('selected').request.record);
  const saved=match.record.players[0].pokemons[0].id;match.record.players[0].pokemons[0].id=1025;
  assert.throws(()=>customMatchPrimitives.makePlayGame(match),/z_figures_changed_after_start/);
  match.record.players[0].pokemons[0].id=saved;const savedState=match.zState;match.zState=null;
  assert.throws(()=>customMatchPrimitives.makePlayGame(match),/z_state_missing_for_record_prefix/);
  match.zState=savedState;
});

test('integrated1717 cannot repeat an accepted spin, consume twice or finalize after match finish',async t=>{
  const {service,match,lastState,lastOutcome}=await replay(t,checkpoint('after-auto0').request.record);
  const projection=()=>JSON.stringify({record:match.record,positions:[...match.positions],waits:[...match.waits],
    turn:match.turn,gauge:match.zGauge,z:hooks.zStateSnapshot(match)});
  const before=projection();
  assert.equal(service.finishBattleSpin(match,lastState),false);
  assert.equal(service.completeBattleResolution(match,lastState,lastOutcome),false);
  assert.equal(projection(),before);
  match.phase='finished';const finished=projection();
  assert.equal(service.finishBattleSpin(match,lastState),false);
  assert.equal(service.completeBattleResolution(match,lastState,lastOutcome),false);
  assert.equal(projection(),finished);
});

for(const folder of ['native-controls-basic','native-controls-adjacent','native-controls-prewait']){
  const archive=new URL(`../docs/generated/z-skill-integration-20260911/${folder}/`,import.meta.url);
  const source=JSON.parse(readFileSync(new URL('manifest.json',archive),'utf8'));
  assert.equal(source.complete,true);assert.equal(source.source_unchanged,true);assert.equal(source.script_unchanged,true);
  assert.equal(source.live_match_commands,0);assert.equal(source.device,'emulator-5554');
  const pairs=new Map(source.queries.map(query=>{
    const result={};
    for(const kind of ['request','response']){
      const bytes=readFileSync(new URL(query[kind+'_file'],archive));
      assert.equal(hash(bytes),query[kind+'_sha256']);result[kind]=JSON.parse(bytes);
    }
    assert.equal(hash(JSON.stringify(result.request.record)),query.record_sha256);
    return [query.sequence,result];
  }));
  for(const entry of source.cases){
    test('integrated1717 fresh native effect/gauge/phase: '+entry.name,async t=>{
      for(const action of entry.actions){
        const pair=pairs.get(action.legal_query_sequence);
        assert.ok(pair.response.legal_moves.some(candidate=>JSON.stringify(candidate)===JSON.stringify(action.move)));
        assert.equal(hash(JSON.stringify(pair.request.record)),action.before_record_sha256);
      }
      const query=source.queries.find(q=>q.label===entry.name+'-z-battle-resolved0'&&q.operation==='status');
      assert.ok(query);
      const fixture=pairs.get(query.sequence),run=await replay(t,fixture.request.record);
      compareState(run.match,fixture.response.status);
      const effects=pairs.get(source.queries.find(q=>q.record_sha256===query.record_sha256&&q.operation==='output_effects').sequence).response.effect_moves;
      assert.deepEqual(run.lastBattleGauge,effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value));
      for(const action of effects.filter(a=>a.value.type==='wait'))for(const actor of action.value.pokemons){
        assert.equal(run.beforeTurn.get(actor),action.value.duration);
      }
      const battle=effects.find(a=>a.value.type==='battle_result').value;
      assert.equal(run.lastOutcome.attackerSkill.id,battle.attack.skill);
      assert.equal(run.lastOutcome.defenderSkill.id,battle.defence.skill);
      const declarationQuery=source.queries.find(q=>q.label===entry.name+'-z-battle-declared'&&q.operation==='output_effects');
      const nativeDisables=pairs.get(declarationQuery.sequence).response.effect_moves.filter(a=>a.value.type==='disable_skill');
      assert.deepEqual(run.match.record.all_moves.filter(a=>a.value.type==='disable_skill').map(({selective_side,value})=>({selective_side,value})),nativeDisables);
      assert.equal(hooks.ensureZState(run.match).active,null);
    });
  }
}
