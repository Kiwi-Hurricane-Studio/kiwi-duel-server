import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';

const files=['double-flight-condition-transition-contract.json','double-flight-defending-condition-contract.json','double-flight-gauge-contract.json','double-flight-landing-melt-contract.json'];
const cases=files.flatMap(file=>JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/'+file,import.meta.url),'utf8')).cases);
for(const c of cases)test(`native Double Flight extra declaration ${c.native_source??''} ${c.name}`,t=>{
  // Own only the scheduler. Every callback below invokes the actual service
  // continuation, including the Freeze DisableSkill-to-Spin boundary.
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  let currentSpin=null;
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(range,pokemon)=>{
    assert(currentSpin,'cancelled declaration cannot request Spin');
    const result=currentSpin.value.spins.find(s=>s.pokemon===pokemon).results[0];assert(result.num<range);return result.num;
  }});
  service.playOpponentTurn=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false};
  const match=service.createMatch('isolated-extra-battle-native');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};
  t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  let completions=0;
  for(const [index,step] of c.steps.entries()){
    const start=match.record.all_moves.length,kind=step.action.value.type;
    if(kind==='spin'){
      currentSpin=step.action;
      const d=match.activeBattleDeclaration;assert(d,'real pending declaration');
      service.resolveBattle(match,d.move,d);
      if(match.record.all_moves.at(-1)?.value.type==='disable_skill')service.performBattleSpin(match,d.move.value.from_pokemon,d.move.value.to_pokemon,d.move.selective_side,d);
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[],c.name+' step '+index);
    assert.equal(match.turn,step.status.turn,'original native turn owner');
    if(step.status.selective_side==='both')assert(match.battleResolutionPending,'pending Both');
    else assert.equal(service.selectionSide(match),step.status.selective_side,'native chooser');
    for(const p of step.status.pokemon_conditions)assert.deepEqual(
      [match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],
      [p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name} step ${index} figure ${p.pokemon_index}`);
    assert.equal(new Set(match.positions.values()).size,12,'unique occupancy');
    for(const row of step.status.z_gauge_conditions)assert.equal(match.zGauge[row.color],row.z_gauge,`step ${index} ${row.color} native gauge`);
    assert.deepEqual(match.record.all_moves.slice(start).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),`step ${index} ordered native receipts`);
    completions+=Number(step.effects.some(m=>m.value.type==='turn_end'));
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,completions,'one root-turn fact');
  }
  assert.equal(completions,1);assert.equal(match.battleResolutionPending,false);
  assert.equal(match.record.all_moves.filter(m=>m.value.type==='spin').length,c.steps.filter(s=>s.action.value.type==='spin').length,'actual original Spin count');
});
