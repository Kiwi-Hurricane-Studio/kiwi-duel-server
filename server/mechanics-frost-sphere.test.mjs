import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService, customMatchTestHooks as hooks, customMatchContract} from './custom-match-engine.mjs';
import {metalSphereSources} from './sphere-plates.mjs';
const cases=["metal-frost-recipient-range-research.json", "metal-frost-holder-range-research.json", "metal-frost-lifecycle-research.json", "metal-frost-duplicate-ice-research.json", "frost-sphere-admission-research.json", "frost-sphere-departure-research.json", "frost-sphere-mutual-immunity-research.json", "frost-sphere-bench-reentry-research.json", "frost-sphere-two-providers-research.json", "sphere-type-admission-research.json", "sphere-field-entry-research.json", "frost-suppressed-duplicate-research.json", "metal-duplicate-admission-research.json"].flatMap(file=>JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/'+file,import.meta.url),'utf8')).cases.filter(c=>c.ok && (c.plate_id===undefined || c.plate_id===5445)).map(c=>({...c,name:file.replace('.json','')+'--'+c.name})));
assert.equal(cases.length,58);
for(const c of cases)test(`native Frost Sphere legal history ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const errors=[],queues=new Map(),service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(range,p)=>{
    const unit=queues.get(p)?.shift();assert(Number.isInteger(unit)&&unit>=0&&unit<range,'only recorded native wheel results');return unit;
  }});
  const outcomes=[],resolve=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const result=resolve(...args);outcomes.push(result);return result};
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,e)=>{errors.push(e);return false};
  const match=service.createMatch('isolated-native-frost-sphere-history');match.record=structuredClone(c.record);match.turn=c.initial_status.turn;match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  service.preflightTurnRecord(match);
  for(const [index,step] of c.steps.entries()){
    const start=match.record.all_moves.length;
    if(step.action.value.type==='declare_plate'&&[5377,5445].includes(step.action.value.plate_id)){
      const plateId=step.action.value.plate_id;
      const targets=step.legal_before.filter(m=>m.value.type==='declare_plate'&&m.value.plate_id===plateId).map(m=>m.value.value.pokemon);
      for(let p=0;p<12;p++)assert.equal(hooks.validatePlateMove(match,step.action.selective_side,{selective_side:step.action.selective_side,value:{type:'declare_plate',plate_id:plateId,value:{type:'select_pokemon_and_declare_aura',pokemon:p}}}),targets.includes(p),'native Sphere target set');
      const invalid=[...Array.from({length:12},(_,p)=>p).filter(p=>!targets.includes(p)),-1,12,true,String(targets[0]),0.5];
      for(const pokemon of invalid){
        const bad=structuredClone(step.action);bad.value.value.pokemon=pokemon;
        const before=structuredClone({record:match.record,plates:match.plateState,positions:match.positions,conditions:match.conditions,turn:match.turn,ledger:match.completedTurnLedger});
        service.acceptPlayerMove(match,bad,bad.selective_side);assert.equal(errors.length,1,'invalid target rejected by actual intake');errors.pop();
        assert.deepEqual({record:match.record,plates:match.plateState,positions:match.positions,conditions:match.conditions,turn:match.turn,ledger:match.completedTurnLedger},before,'invalid Sphere leaves complete authoritative state unchanged');
      }
    }
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
      const result=step.effects.find(e=>e.value.type==='battle_result')?.value;
      if(result)assert.deepEqual([outcomes.at(-1).attackerSkill.speed_or_damage,outcomes.at(-1).defenderSkill.speed_or_damage],[result.attack.speed_or_damage,result.defence.speed_or_damage],'native Metal Sphere damage on actual resolver');
      const declares=step.effects.filter(e=>e.value.type==='declare_spin');
      if(declares.length)assert.deepEqual(match.pendingSecondarySpins.outcome.secondarySpins.map(p=>p.targets),declares.map(e=>e.value.pokemons),'native spatial declaration order');
      else assert.equal(match.pendingSecondarySpins,null);
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[],`history action ${index} accepted`);assert.equal(match.turn,step.status.turn);
    if(step.status.selective_side==='both')assert(match.battleResolutionPending);else assert.equal(service.selectionSide(match),step.status.selective_side);
    for(const p of step.status.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],[p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name}/${index} native figure ${p.pokemon_index}`);
    assert.deepEqual(hooks.plateStateSnapshot(match).plate_conditions,step.status.plate_conditions,'every equipped copy retains native aura/used/unused state');
    for(const p of step.status.pokemon_conditions)assert.equal(hooks.plateStateSnapshot(match).attachments.some(a=>a.pokemon===p.pokemon_index&&a.effect.charge_effect),Boolean(p.effect.charge_effect),'native source charge attachment '+p.pokemon_index);
    for(const p of step.status.pokemon_conditions)assert.equal(metalSphereSources(match.record,match.positions,match.plateState,p.pokemon_index,customMatchContract.fieldEdges).length>0,(p.effect.ids.plates??[]).includes(5377),'native derived aura membership '+p.pokemon_index);
    for(const p of step.status.pokemon_conditions)assert.equal(match.plateState.attachments.some(a=>a.plate_id===5445&&a.pokemon===p.pokemon_index),(p.effect.ids.plates??[]).includes(5445),'native Frost holder-only membership '+p.pokemon_index);
    assert.equal(new Set(match.positions.values()).size,12);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
    assert.deepEqual(match.record.all_moves.slice(start).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(e=>e.value.type==='add_z_gauge').map(e=>e.value),'native ordered gauge receipts');
  }
  assert.equal(match.battleResolutionPending,false);assert.equal(match.pendingSecondarySpins,null);assert.equal(match.pendingJump,null);
  if(c.scenario==='same-holder')assert.equal(hooks.validatePlateMove(match,match.turn,{selective_side:match.turn,value:{type:'declare_plate',plate_id:5377,value:{type:'select_pokemon_and_declare_aura',pokemon:c.owner}}}),false,'native existing holder cannot receive duplicate Sphere');
});
