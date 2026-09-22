import assert from 'node:assert/strict';
import test from 'node:test';
import {CustomMatchService,customMatchPrimitives,customMatchTestHooks as hooks} from './custom-match-engine.mjs';
import {nativeArchive,replayNativeZ,compareNativeZStatus} from './test-support/native-z-replay.mjs';
import {HumanMatchService} from './human-match-service.mjs';
import {finishZBattle} from './z-skill-transaction.mjs';

const old=nativeArchive('docs/generated/z-skill-lifecycle-20260910/native-followups');
const fresh=nativeArchive('docs/generated/z1715-integration-20260911/native-white',
  '36ec53b6ebb5aa01a66339e465362cd355c96cf25cfe78cbb613c960460d358b');
const gold=nativeArchive('docs/generated/z1715-integration-20260911/native-gold-part4',
  '7a519cc12e128a059edf77a701ca7b3db2d899eee40b5a4546702a82df06ce8b');

test('1715 Gold archive binds all four continuation windows and67 revalidated prefix moves',()=>{
  assert.equal(gold.manifests.length,4);assert.equal(gold.pairs.size,86);
  assert.equal(gold.manifests.flatMap(m=>m.cases.flatMap(c=>c.actions)).filter(a=>/^gold-prefix\d+$/.test(a.label)).length,67);
  assert.deepEqual(gold.get('gold-before-z').response.status.z_gauge_conditions,
    [{color:'black',z_gauge:99},{color:'white',z_gauge:100}]);
});
for(const label of ['gold-selected','gold-declared','gold-resolved0'])test('integrated1715 verified Gold full prefix: '+label,async t=>{
  const fixture=gold.get(label),run=await replayNativeZ(t,fixture.request.record);
  compareNativeZStatus(run.match,fixture.response.status);
  if(label!=='gold-resolved0')return;
  const effects=gold.get(label,'output_effects').response.effect_moves;
  assert.deepEqual(run.lastBattleGauge,effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),
    'Gold loss keeps separate KO, -50 final and +1 next-turn causes');
  assert.equal(run.lastOutcome.winner,0);assert.equal(run.lastOutcome.loser,6);
  assert.equal(run.match.positions.get(6),43);assert.equal(run.match.waits.get(6),0);
  assert.deepEqual(run.match.zGauge,{black:100,white:50});
  assert.equal(hooks.ensureZState(run.match).active,null);
});

const stateSnapshot=match=>JSON.stringify({record:match.record,positions:[...match.positions],waits:[...match.waits],
  conditions:[...match.conditions],gauge:match.zGauge,turn:match.turn,z:hooks.ensureZState(match),
  pendingBattles:match.pendingBattles,resolution:match.activeBattleResolution,pending:match.battleResolutionPending});

// Actual human command/framing/authority handlers with in-memory peer transports.
// No account store, listener or profile is created. Authored fixture metadata is
// assigned only before the empty record; all state then follows accepted actions.
function humanFixture(t,record,spinUnitSource=()=>0){
  const service=new HumanMatchService({port:0,moveDelayMs:0,clockSource:()=>1800000000000,
    firstPresentationMs:0,turnPresentationMs:0,battlePresentationMs:0,presentationSlackMs:0,spinUnitSource});
  const entries=[0,1].map(i=>({id:97001+i,user:{user_id:97001+i,display_name:'Private_Z_Test_'+i},deck:null}));
  const match=service.pair(...entries);match.phase='started';
  for(const player of match.record.players){const source=record.players.find(p=>p.color===player.color);
    player.pokemons=structuredClone(source.pokemons);player.plates=[...source.plates];}
  const lines=[];
  for(const peer of match.peers){
    peer.ready=true;peer.session='in-memory-z-test-'+peer.side;
    peer.socket={destroyed:false,writable:true,write:line=>lines.push({side:peer.side,line}),
      end:line=>{lines.push({side:peer.side,line});peer.socket.writableEnded=true;},destroy:()=>{peer.socket.destroyed=true;}};
    peer.connectionState={match,peer};
  }
  const send=action=>{const peer=match.peers.find(p=>p.side===action.selective_side);
    service.handleLine(peer.socket,peer.connectionState,
      `sequence ${peer.clientSendIndex+1} ${peer.serverSendIndex} do_move ${JSON.stringify(action)}`);};
  t.after(()=>{match.phase='finished';});
  for(const action of record.all_moves){
    if(action.selective_side==='both')continue;
    send(action);assert.ok(!lines.some(row=>row.line.startsWith('move_rejected')),'native prefix accepted by human authority');
  }
  return {service,match,send,lines};
}

for(const [name,skill,code] of [
  ['Purple tie',{id:1005,color:2,range:96,speed_or_damage:4},'z1715_draw_unproven'],
  ['Blue',{id:1127,color:4,range:96,speed_or_damage:0},'z1715_blue_response_unproven'],
  ['higher Purple',{id:1005,color:2,range:96,speed_or_damage:5},'z1715_non_gold_loss_unproven'],
])for(const mode of ['training','human'])test(`${mode} refuses unproved1715 ${name} before selection, with explicit capability diagnostics`,async t=>{
  // Negative authored counterfactual, NOT a native outcome claim.
  const record=structuredClone(gold.get('gold-before-z').request.record);
  record.players[0].pokemons[0].skills=[skill];
  const run=mode==='human'?humanFixture(t,record):await replayNativeZ(t,record);
  const {match,service}=run,choice={selective_side:'white',value:{type:'z_skill',pokemon:6,dst_skill_id:1715,speed_or_damage:4}};
  const advertised=customMatchPrimitives.makePlayGame(match).ZState;
  assert.deepEqual(advertised.supported_skill_ids,[1715,1717],'1715 is not globally removed');
  assert.ok(!advertised.legal_actions.some(a=>a.value.pokemon===6&&a.value.dst_skill_id===1715));
  assert.ok(advertised.diagnostics.unresolved_transitions.some(d=>d.code===code&&d.pokemon===6&&d.target_pokemon===0));
  const before=stateSnapshot(match);let callbacks=0;service.resolveBattle=()=>{callbacks++;};
  assert.doesNotThrow(()=>mode==='human'?run.send(choice):service.acceptPlayerMove(match,choice,'white'));
  assert.equal(stateSnapshot(match),before,'no clock pause, marker, move, position, gauge or turn commit');
  assert.equal(hooks.ensureZState(match).active,null,'not trapped in selected Z');
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(callbacks,0,'no unsafe deferred spin scheduled');
  if(mode==='human')assert.ok(run.lines.some(row=>row.line.includes('illegal_player_z_skill')));
  else assert.deepEqual(run.errors,['illegal_player_z_skill']);
});

test('known1715 Gold loss reaches native state through scheduled human command route',async t=>{
  const fixture=gold.get('gold-resolved0'),spin=fixture.request.record.all_moves.at(-1);
  const units=[6,0].map(actor=>spin.value.spins.find(s=>s.pokemon===actor).results[0].num);
  const run=humanFixture(t,fixture.request.record,maximum=>{const unit=units.shift();assert.ok(unit>=0&&unit<maximum);return unit;});
  const deadline=Date.now()+2000;
  while(run.match.turn!=='black'||hooks.ensureZState(run.match).active){
    assert.ok(Date.now()<deadline,'scheduled human spin completes without uncaught callback exception');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  compareNativeZStatus(run.match,fixture.response.status);assert.equal(units.length,0);
  const values=run.match.record.all_moves.filter(a=>a.value.type==='add_z_gauge').slice(-3).map(a=>a.value);
  assert.deepEqual(values,gold.get('gold-resolved0','output_effects').response.effect_moves.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value));
  assert.equal(run.match.resolving,false);
});

test('1715 unknown draw remains a pure fail-closed transaction boundary',async t=>{
  const run=await replayNativeZ(t,gold.get('gold-declared').request.record),state=hooks.ensureZState(run.match),before=JSON.stringify(state);
  assert.throws(()=>finishZBattle(state,{finalized:true,attackingSide:'white',attacker:6,defender:0,
    attackerColor:2,defenderColor:2,zBattleOutcome:'draw',knockoutSide:null}),/z_unsuccessful_destination_not_proven/);
  assert.equal(JSON.stringify(state),before);
});

for(const mode of ['training','human'])test(`${mode} stale1715 capability and immutable record are rejected before declaration side effects`,async t=>{
  const record=gold.get('gold-declare-battle-choose','legal_moves').request.record;
  const run=mode==='human'?humanFixture(t,record):await replayNativeZ(t,record);
  // Deliberately corrupt a test-owned wheel after a valid selection to model
  // stale/inconsistent capability data. This is NOT a legal native mutation.
  run.match.record.players[0].pokemons[0].skills=[{id:1005,color:2,range:96,speed_or_damage:4}];
  const action={selective_side:'white',value:{type:'declare_battle',from_pokemon:6,to_pokemon:0}};
  assert.equal(hooks.zBattleCapability(run.match,6,0).code,'z1715_draw_unproven');
  assert.equal(hooks.validateBattleDeclaration(run.match,'white',action),false);
  const before=stateSnapshot(run.match);let callbacks=0;run.service.resolveBattle=()=>{callbacks++;};
  assert.doesNotThrow(()=>mode==='human'?run.send(action):run.service.acceptPlayerMove(run.match,action,'white'));
  assert.equal(stateSnapshot(run.match),before);
  assert.equal(hooks.ensureZState(run.match).active.phase,'battle_choice');
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(callbacks,0);
  // The immutable definition binding rejects this deliberate corruption before
  // the capability gate above. Both protections must remain effective.
  if(mode==='human')assert.ok(run.lines.some(row=>row.line.includes('completion_record_invalid')));
  else assert.deepEqual(run.errors,['completion_record_invalid']);
});

for(const [archive,labels]of [
  [old,['white-field-purple1715-selected','white-field-purple1715-after-route0',
    'black-field-purple1715-selected','black-field-purple1715-after-battle','black-field-purple1715-after-auto0']],
  [fresh,['white-selected','white-declared','white-resolved0']],
])for(const label of labels){
  test('integrated1715 full native prefix: '+label,async t=>{
    const fixture=archive.get(label),run=await replayNativeZ(t,fixture.request.record);
    compareNativeZStatus(run.match,fixture.response.status);
    const state=customMatchPrimitives.makePlayGame(run.match).ZState;
    assert.equal(state.record_move_count,run.match.record.all_moves.length);
    assert.deepEqual(state.supported_skill_ids,[1715,1717]);
    if(state.active){
      assert.equal(state.active.dst_skill_id,1715);assert.equal(state.active.speed_or_damage,4);
      assert.deepEqual(hooks.selectedSkill(run.match,state.active.pokemon,95),
        {id:1715,range:96,speed_or_damage:4,color:2,format:1,z_skill:true});
    }else if(fixture.request.record.all_moves.at(-1).value.type==='spin'){
      const effects=archive.get(label,'output_effects').response.effect_moves;
      assert.deepEqual(run.lastBattleGauge,effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),
        'separate KO, final consumption and next-turn receipts match native');
      const battle=effects.find(a=>a.value.type==='battle_result').value;
      assert.equal(run.lastOutcome.attackerSkill.id,battle.attack.skill);
      assert.equal(run.lastOutcome.defenderSkill.id,battle.defence.skill);
      assert.equal(run.lastOutcome.winner,battle.attack.pokemon);
      assert.deepEqual(run.lastOutcome.knockoutPokemons,[battle.defence.pokemon]);
      assert.equal(run.match.waits.get(battle.defence.pokemon),0,'effect KO must not invent generic Wait');
      assert.equal(hooks.selectedSkill(run.match,battle.attack.pokemon,95).id,1131);
    }
  });
}

test('integrated1715 completed KO callback cannot relocate, spend, award or turn twice',async t=>{
  const fixture=fresh.get('white-resolved0'),run=await replayNativeZ(t,fixture.request.record);
  const {service,match,lastState,lastOutcome,lastSteps}=run;
  const snapshot=()=>JSON.stringify({record:match.record,positions:[...match.positions],waits:[...match.waits],
    conditions:[...match.conditions],gauge:match.zGauge,turn:match.turn,z:hooks.zStateSnapshot(match)});
  const before=snapshot();
  assert.equal(service.finishBattleSpin(match,lastState),false);
  assert.equal(service.completeKnockoutBatch(match,lastState,lastOutcome,lastSteps),false);
  assert.equal(service.completeBattleResolution(match,lastState,lastOutcome),false);
  assert.equal(snapshot(),before);
  match.phase='finished';const ended=snapshot();
  assert.equal(service.completeKnockoutBatch(match,lastState,lastOutcome,lastSteps),false);
  assert.equal(snapshot(),ended);
});

test('integrated1715 cannot finalize while its knockout has not reached the P.C.',async t=>{
  const record=fresh.get('white-declared').request.record;
  const run=await replayNativeZ(t,record),{service,match}=run;
  const spin=fresh.get('white-resolved0').request.record.all_moves.at(-1);
  const units=[6,0].map(actor=>spin.value.spins.find(row=>row.pokemon===actor).results[0].num);
  service.spinUnitSource=maximum=>{const value=units.shift();assert.ok(value>=0&&value<maximum);return value;};
  const complete=service.completeKnockoutBatch.bind(service);let held;
  service.completeKnockoutBatch=(...args)=>{assert.equal(held,undefined);held=args;return false;};
  CustomMatchService.prototype.resolveBattle.call(service,match,record.all_moves.at(-1));
  assert.ok(held);assert.equal(match.conditions.get(0),'faint');assert.equal(match.positions.get(0),15);
  const before=JSON.stringify({record:match.record,gauge:match.zGauge,z:match.zState,turn:match.turn});
  assert.equal(service.completeBattleResolution(match,held[1],held[2]),false);
  assert.equal(JSON.stringify({record:match.record,gauge:match.zGauge,z:match.zState,turn:match.turn}),before);
  assert.equal(match.activeBattleResolution.phase,'applying');
  assert.equal(complete(...held),true);
  compareNativeZStatus(match,fresh.get('white-resolved0').response.status);
});
