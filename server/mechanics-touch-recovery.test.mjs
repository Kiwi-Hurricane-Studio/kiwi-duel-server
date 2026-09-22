import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/touch-recovery-contract.json',import.meta.url),'utf8'));
const semantic=move=>({selective_side:move.selective_side,value:move.value});
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],triangles:[...m.triangles],waits:[...m.waits],turn:m.turn,ledger:m.completedTurnLedger,gauge:m.zGauge,pending:m.pendingTouch});
function checkState(service,match,native,label){
  assert.equal(match.turn,native.turn,label+' turn');assert.equal(service.selectionSide(match),native.selective_side,label+' selection');
  for(const p of native.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],
    [p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],label+' figure '+p.pokemon_index);
  for(const g of native.z_gauge_conditions)assert.equal(match.zGauge[g.color],g.z_gauge,label+' gauge '+g.color);
  assert.equal(new Set(match.positions.values()).size,12,label+' occupancy');
}
for(const c of contract.cases)test(`native Touch p${c.owner} ${c.native_source} ${c.config.name}`,t=>{
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0});service.playOpponentTurn=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-native-touch');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  const side=c.action.selective_side;
  assert.deepEqual(service.touchChoices(match,side),c.legal_before.filter(a=>a.value.type==='touch'),'native initial Touch choices');
  if(!c.config.start_adjacent){
    service.acceptPlayerMove(match,c.action,side);assert.deepEqual(errors,[]);checkState(service,match,c.after_movement,'after MP');
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,c.movement_effects.some(a=>a.value.type==='turn_end')?1:0);
    const choices=[...match.pendingBattles.map(semantic),...service.touchChoices(match,side)];
    assert.deepEqual(choices,c.legal_after_movement.filter(a=>['touch','declare_battle'].includes(a.value.type)),'native post-MP battle and Touch');
  }
  const legal=service.touchChoices(match,side);
  const before=snapshot(match);
  const base={selective_side:side,value:{from_pokemon:c.mover,to_pokemon:c.holder,type:'touch'}};
  const invalid=[{...base,value:{...base.value,to_pokemon:c.mover}},{...base,value:{...base.value,to_pokemon:12}},{...base,value:{...base.value,from_pokemon:String(c.mover)}},{...base,value:{...base.value,extra:1}},{...base,selective_side:side==='black'?'white':'black'}];
  for(const bad of invalid){assert.equal(service.acceptPlayerMove(match,bad,bad.selective_side),false);assert.equal(snapshot(match),before);assert.equal(errors.length,1);errors.length=0;}
  if(match.pendingTouch){
    for(const bad of [{selective_side:side,value:{type:'declare_turn_end'}},c.action]){assert.equal(service.acceptPlayerMove(match,bad,side),false);assert.equal(snapshot(match),before);errors.length=0;}
    const pending=match.pendingTouch;pending.pokemon=c.owner+2;assert.equal(service.acceptPlayerMove(match,base,side),false);pending.pokemon=c.mover;assert.equal(snapshot(match),before);errors.length=0;
  }
  if(!c.choice_advertised){assert.equal(legal.some(a=>a.value.to_pokemon===c.holder),false);return;}
  const start=match.record.all_moves.length;
  service.acceptPlayerMove(match,{display_info:'move',...c.choice},side);assert.deepEqual(errors,[]);checkState(service,match,c.final_status,'after choice');
  assert.equal(match.pendingTouch,null);assert.equal(match.pendingBattles.length,0);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,1);
  assert.deepEqual(match.record.all_moves.slice(start).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),c.choice_effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),'native ordered gauge events');
  const after=snapshot(match);assert.equal(service.acceptPlayerMove(match,c.choice,side),false);assert.equal(snapshot(match),after);
});

const histories=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/touch-history-contract.json',import.meta.url),'utf8')).cases;
const compounds=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/grudge-touch-contract.json',import.meta.url),'utf8')).cases;
for(const c of compounds)test(`native Grudge then Touch p${c.owner} ${c.condition} ${c.choice_type}`,t=>{
  const errors=[],probability=c.steps.find(s=>s.phase==='probability');
  const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(maximum,pokemon)=>{
    assert.equal(pokemon,c.target);const unit=probability.action.value.spins[0].results[0].num;assert(unit>=0&&unit<maximum);return unit;
  }});
  service.playOpponentTurn=()=>{};service.scheduleOpponentGrudge=()=>{};service.schedulePendingGrudge=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-grudge-touch');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  let completed=0;
  for(const step of c.steps){
    const start=match.record.all_moves.length;
    if(step.phase==='probability')assert.equal(service.performPendingGrudge(match,match.pendingGrudge),true);
    else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    assert.deepEqual(errors,[]);checkState(service,match,step.status,step.phase);
    completed+=Number(step.effects.some(e=>e.value.type==='turn_end'));
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,completed);
    assert.deepEqual(match.record.all_moves.slice(start).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),step.effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value));
    if(step.phase==='probability'){
      assert.deepEqual(service.touchChoices(match,match.turn),step.legal.filter(a=>a.value.type==='touch'));
      assert.equal(match.pendingBattles.length,0);assert(match.pendingTouch);assert.equal(match.pendingGrudge,null);
    }
  }
  assert.equal(completed,1);assert.equal(match.pendingTouch,null);
  assert.equal(match.triangles.get(c.target),'curse');assert.equal(match.waits.get(c.target),2);
  const settled=snapshot(match),last=c.steps.at(-1).action;
  assert.equal(service.acceptPlayerMove(match,last,last.selective_side),false);assert.equal(snapshot(match),settled);
});
for(const c of histories)test(`native Touch legal history p${c.owner} ${c.condition} ${c.choice_type}`,t=>{
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0});service.playOpponentTurn=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-touch-history');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  let completed=0;
  for(const [index,step] of c.steps.entries()){
    const start=match.record.all_moves.length;
    if(step.action.value.type==='spin')service.resolveBattle(match,c.steps[index-1].action,match.activeBattleDeclaration);
    else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    assert.deepEqual(errors,[]);
    if(step.action.value.type==='declare_battle'){
      assert.equal(match.battleResolutionPending,true,'ordinary battle resolution owns Both');assert.equal(match.turn,step.status.turn);
    }else checkState(service,match,step.status,'legal step '+index);
    completed+=Number(step.effects.some(e=>e.value.type==='turn_end'));
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,completed,'one completion per native TurnEnd');
    assert.deepEqual(match.record.all_moves.slice(start).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),step.effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),'native history ordered gauge events');
  }
});
