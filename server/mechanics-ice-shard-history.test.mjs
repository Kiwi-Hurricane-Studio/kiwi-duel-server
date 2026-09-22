import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
const cases=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/ice-shard-history-contract.json',import.meta.url),'utf8')).cases;
for(const c of cases)test(`native full legal Ice Shard history ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const errors=[],queues=new Map(),service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(range,p)=>{
    const unit=queues.get(p)?.shift();assert(Number.isInteger(unit)&&unit>=0&&unit<range,'only recorded native wheel results');return unit;
  }});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,e)=>{errors.push(e);return false};
  const match=service.createMatch('isolated-native-ice-shard-history');match.record=structuredClone(c.record);match.turn=c.initial_status.turn;match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  service.preflightTurnRecord(match);
  for(const [index,step] of c.steps.entries()){
    const start=match.record.all_moves.length;
    if(step.action.value.type==='spin'){
      for(const s of step.action.value.spins)queues.set(s.pokemon,s.results.map(r=>r.num));
      if(step.action.value.spins.every(s=>s.results.every(r=>r.type==='probability'))){
        assert(match.pendingSecondarySpins);assert.equal(service.performSecondarySpins(match,match.pendingSecondarySpins),true);
      }else{
        const declaration=match.record.all_moves.findLast(m=>m.value.type==='declare_battle');
        service.performBattleSpin(match,declaration.value.from_pokemon,declaration.value.to_pokemon,declaration.selective_side,match.activeBattleDeclaration);
      }
      assert.deepEqual(match.record.all_moves.filter(m=>m.value.type==='spin').at(-1).value,step.action.value,'native exact Spin wire order');
      assert([...queues.values()].every(q=>q.length===0));
      const declares=step.effects.filter(e=>e.value.type==='declare_spin');
      if(declares.length)assert.deepEqual(match.pendingSecondarySpins.outcome.secondarySpins.map(p=>p.targets),declares.map(e=>e.value.pokemons),'native spatial declaration order');
      else assert.equal(match.pendingSecondarySpins,null);
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[],`history action ${index} accepted`);assert.equal(match.turn,step.status.turn);
    if(step.status.selective_side==='both')assert(match.battleResolutionPending);else assert.equal(service.selectionSide(match),step.status.selective_side);
    for(const p of step.status.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],[p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name}/${index} native figure ${p.pokemon_index}`);
    assert.equal(new Set(match.positions.values()).size,12);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
    assert.deepEqual(match.record.all_moves.slice(start).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(e=>e.value.type==='add_z_gauge').map(e=>e.value),'native ordered gauge receipts');
  }
  assert.equal(match.battleResolutionPending,false);assert.equal(match.pendingSecondarySpins,null);assert.equal(match.pendingJump,null);
});
