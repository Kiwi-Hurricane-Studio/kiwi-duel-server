import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';

const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/entry-marker-recovery-contract.json',import.meta.url),'utf8'));
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],triangles:[...m.triangles],waits:[...m.waits],battled:[...m.battledAfterField],ledger:m.completedTurnLedger,gauge:m.zGauge});
for(const c of contract.cases)test(`native entry marker recovery ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false};
  const match=service.createMatch('isolated-native-entry-markers');match.record=structuredClone(c.record);match.turn=c.seeded_status.turn;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  const step=c.steps[0],before=match.record.all_moves.length;
  service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
  assert.deepEqual(errors,[]);assert.equal(match.turn,step.status.turn);assert.equal(service.selectionSide(match),step.status.selective_side);
  for(const p of step.status.pokemon_conditions)assert.deepEqual(
    [match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],
    [p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name} native figure ${p.pokemon_index}`);
  assert.equal(new Set(match.positions.values()).size,12,'entry preserves unique occupancy');
  assert.deepEqual(match.record.all_moves.slice(before).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),'exact native turn gauge');
  assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
  const settled=snapshot(match);service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
  assert.deepEqual(errors,['stale_player_turn']);assert.equal(snapshot(match),settled,'stale entry cannot repeat recovery or age Wait');
});
