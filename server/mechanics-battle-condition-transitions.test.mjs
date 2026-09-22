import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService} from './custom-match-engine.mjs';

const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/battle-condition-transition-contract.json',import.meta.url),'utf8'));
contract.cases.push(...JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/battle-wake-conditional-ko-contract.json',import.meta.url),'utf8')).cases);
function checkState(service,match,native,label){
  assert.equal(match.turn,native.turn,label+' turn');
  if(native.selective_side==='both')assert.equal(match.battleResolutionPending,true,label+' pending battle owns Both');
  else assert.equal(service.selectionSide(match),native.selective_side,label+' selection');
  for(const p of native.pokemon_conditions){
    assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],
      [p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],label+' figure '+p.pokemon_index);
  }
  for(const row of native.z_gauge_conditions)assert.equal(match.zGauge[row.color],row.z_gauge,label+' gauge '+row.color);
  assert.equal(new Set(match.positions.values()).size,12,label+' unique occupancy');
}
for(const c of contract.cases)for(const path of c.owner===0?['player','training']:['player'])test(`native battle condition ${c.native_source} ${c.name} ${path}`,async t=>{
  const errors=[],spinStep=c.steps.find(s=>s.phase==='spin');
  const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(maximum,pokemon)=>{
    assert(spinStep,'cancelled declaration cannot request a wheel spin');
    const unit=spinStep.action.value.spins.find(s=>s.pokemon===pokemon).results[0].num;
    assert(unit>=0&&unit<maximum);return unit;
  }});
  service.playOpponentTurn=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-battle-condition-transition');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  let completed=0;
  for(const step of c.steps){
    const start=match.record.all_moves.length;
    if(step.phase==='declaration'){
      if(path==='training'){
        // Controlled continuation input for the real training chooser. The
        // native state oracle is unchanged; no legal-history claim is made.
        match.pendingBattles=[structuredClone(step.action)];
        CustomMatchService.prototype.playOpponentTurn.call(service,match);
      }else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    }
    else {
      service.resolveBattle(match,c.steps[0].action,match.activeBattleDeclaration);
      const deadline=Date.now()+2000;
      while(match.battleResolutionPending&&Date.now()<deadline)await delay(10);
      assert.equal(match.battleResolutionPending,false,'actual deferred disable-skill/spin path settles');
    }
    assert.deepEqual(errors,[]);checkState(service,match,step.status,step.phase);
    completed+=Number(step.effects.some(e=>e.value.type==='turn_end'));
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,completed,step.phase+' completion count');
    assert.deepEqual(match.record.all_moves.slice(start).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),step.effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),step.phase+' ordered native gauge events');
  }
  assert.equal(completed,1);assert.equal(match.battleResolutionPending,false);
  assert.equal(match.record.all_moves.filter(a=>a.value.type==='spin').length,spinStep?1:0,'one battle spin or native pre-spin cancellation');
});
