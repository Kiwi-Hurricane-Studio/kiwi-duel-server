import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';

const contract={cases:['flight-ice-shard-contract.json','surge-participant-notice-contract.json','surge-ally-star-notice-contract.json','fly-occupied-transit-contract.json'].flatMap(file=>JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/'+file,import.meta.url),'utf8')).cases)};
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],triangles:[...m.triangles],waits:[...m.waits],battled:[...m.battledAfterField],ledger:m.completedTurnLedger,gauge:m.zGauge});
for(const c of contract.cases)test(`native flight versus converted Ice Shard ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false};
  const match=service.createMatch('isolated-native-flight-ice-shard');match.record=structuredClone(c.record);match.turn=c.seeded_status.turn;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  for(const [index,step] of c.steps.entries()){
    const before=match.record.all_moves.length;
    if(step.action.value.type==='spin'){
      const v=c.steps[0].action.value;
      service.performBattleSpin(match,v.from_pokemon,v.to_pokemon,c.steps[0].action.selective_side,match.activeBattleDeclaration);
      assert.deepEqual(match.record.all_moves.filter(m=>m.value.type==='spin').at(-1).value,step.action.value,'exact original battle spin');
      assert.equal(match.pendingSecondarySpins,null,'Purple loss must not request Ice Shard follow-up');
      assert.deepEqual(match.pendingJump.outcome.secondarySpins,[],'no deferred Sphere spin before landing');
      assert.equal(match.pendingJump.unresolved_reason,undefined,'observed flight continuation is usable');
      assert(match.pendingJump.targets.includes(c.steps[2].action.value.to),'original landing remains available');
      assert.deepEqual([...match.pendingJump.targets].sort((a,b)=>a-b),c.steps[2].legal_before.filter(a=>a.value.type==='spot_move').map(a=>a.value.to).sort((a,b)=>a-b),'all native landings preserve empty endpoints and occupied intermediate transit');
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[]);assert.equal(match.turn,step.status.turn);
    if(step.action.value.type==='declare_battle'){
      assert.equal(step.status.selective_side,'both');assert(match.battleResolutionPending&&match.activeBattleDeclaration,'automatic Spin owns the pending Both boundary');
    }else assert.equal(service.selectionSide(match),step.status.selective_side);
    for(const p of step.status.pokemon_conditions)assert.deepEqual(
      [match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],
      [p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name}/${index} native figure ${p.pokemon_index}`);
    assert.equal(new Set(match.positions.values()).size,12,'unique occupancy after every continuation');
    assert.deepEqual(match.record.all_moves.slice(before).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),'exact native gauge sequence');
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
    if(index===1){const saved=snapshot(match);const v=c.steps[0].action.value;service.performBattleSpin(match,v.from_pokemon,v.to_pokemon,c.steps[0].action.selective_side,match.activeBattleDeclaration);assert.equal(snapshot(match),saved,'duplicate original battle callback cannot create a secondary spin');}
  }
  assert.equal(match.pendingJump,null);assert.equal(match.pendingExtraBattle,null);assert.equal(match.battleResolutionPending,false);
});
