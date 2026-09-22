import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
import {grudgeStoneChoices} from './grudge-stone.mjs';

const cases=['grudge-entry-phase-contract.json','grudge-plate-entry-contract.json'].flatMap(file=>
  JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/'+file,import.meta.url),'utf8')).cases);
function snapshot(match){return JSON.stringify({record:match.record,points:[...match.positions],conditions:[...match.conditions],triangles:[...match.triangles],waits:[...match.waits],turn:match.turn,gauge:match.zGauge,plate:match.plateState,ledger:match.completedTurnLedger});}
function checkState(service,match,status,label){
  assert.equal(match.turn,status.turn,label+' turn');
  assert.equal(service.selectionSide(match),status.selective_side,label+' selection side');
  for(const p of status.pokemon_conditions)assert.deepEqual(
    [match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index)],
    [p.index,p.marker.circle,p.marker.triangle,p.wait],label+' figure '+p.pokemon_index);
  assert.equal(new Set(match.positions.values()).size,12,label+' occupancy');
  for(const row of status.z_gauge_conditions)assert.equal(match.zGauge[row.color],row.z_gauge,label+' gauge '+row.color);
  for(const row of status.plate_conditions)for(const card of row.plates){
    const actual=match.plateState?.plate_conditions.find(p=>p.color===row.color)?.plates.find(p=>p.id===card.id);
    assert.equal(actual?.condition,card.condition,label+' plate '+row.color+'/'+card.id);
  }
}
for(const c of cases)test(`original Grudge phases p${c.owner} ${c.mode??c.plate}`,t=>{
  const errors=[],sent=[];
  const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(maximum,pokemon)=>{
    const spin=c.steps[2].action.value.spins[0];assert.equal(pokemon,spin.pokemon);const unit=spin.results[0].num;assert(unit>=0&&unit<maximum);return unit;
  }});
  service.playOpponentTurn=()=>{};service.scheduleOpponentGrudge=()=>{};service.schedulePendingGrudge=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-grudge-entry');match.record=structuredClone(c.initial_record);match.record.all_moves=[];match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(value){sent.push(value)},destroy(error){errors.push(error?.message)}};
  t.after(()=>{match.phase='finished'});
  for(const action of c.initial_record.all_moves){service.acceptPlayerMove(match,action,action.selective_side);assert.deepEqual(errors,[]);}
  checkState(service,match,c.initial_status,'legal history prefix');
  const initialTurns=service.completedTurnCheckpoint(match).checkpoint.state.completed_turns;
  for(const [index,step] of c.steps.entries()){
    const prior=match.record.all_moves.length;
    if(index===2){
      const pending=match.pendingGrudge;assert(pending?.declared);
      const before=snapshot(match);assert.equal(service.performPendingGrudge(match,{...pending}),false);assert.equal(snapshot(match),before);
      const target=pending.target;pending.target=c.owner;assert.equal(service.performPendingGrudge(match,pending),false);assert.equal(snapshot(match),before);pending.target=target;
      assert.equal(service.performPendingGrudge(match,pending),true);
      const after=snapshot(match);assert.equal(service.performPendingGrudge(match,pending),false);assert.equal(snapshot(match),after);
    }else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    assert.deepEqual(errors,[]);checkState(service,match,step.status,step.phase);
    const generated=match.record.all_moves.slice(prior);
    assert.deepEqual(generated.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),step.effects.filter(a=>a.value.type==='add_z_gauge').map(a=>a.value),'ordered native gauge effects');
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,initialTurns+(step.effects.some(e=>e.value.type==='turn_end')?1:0),'entry phase finality');
    if(index===0){
      assert.deepEqual(grudgeStoneChoices(match.turn,match.positions),step.legal,'every native target including self and allies');
      const before=snapshot(match),side=match.turn;
      const selection=c.steps[1].action;
      for(const invalid of [{selective_side:side,value:{type:'null_move'}},{...selection,value:{...selection.value,pokemons:[]}},{...selection,value:{...selection.value,pokemons:[c.owner+2]}},{...selection,value:{...selection.value,pokemons:[c.owner,c.owner+1]}},{...selection,value:{...selection.value,unexpected:1}},{...selection,selective_side:side==='black'?'white':'black'}]){
        assert.equal(service.acceptPlayerMove(match,invalid,invalid.selective_side),false);assert.equal(snapshot(match),before);assert.equal(errors.length,1);errors.length=0;
      }
    }
    if(index===1){
      const before=snapshot(match);assert.equal(service.acceptPlayerMove(match,step.action,step.action.selective_side),false);assert.equal(snapshot(match),before);assert.deepEqual(errors,['stale_player_turn']);errors.length=0;
    }
  }
  const expected=c.steps[2].legal.filter(a=>a.value.type==='declare_battle');
  assert.deepEqual(match.pendingBattles,expected.map(action=>({display_info:'move',...action})));
  if(expected.length){
    service.acceptPlayerMove(match,{selective_side:match.turn,value:{type:'null_move'}},match.turn);assert.deepEqual(errors,[]);
    assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,initialTurns+1);
    assert.equal(match.pendingBattles.length,0);
  }
});

const conditionCases=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/grudge-probability-conditions-contract.json',import.meta.url),'utf8')).cases;
const switchCases=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/switch-bench-cleanup-contract.json',import.meta.url),'utf8')).cases;
for(const c of switchCases)test(`native Switch bench cleanup p${c.owner} ability${c.ability}`,t=>{
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0});
  service.playOpponentTurn=()=>{};service.scheduleOpponentGrudge=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-native-switch-cleanup');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
  service.acceptPlayerMove(match,c.action,c.action.selective_side);assert.deepEqual(errors,[]);checkState(service,match,c.status,'Switch cleanup');
  assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,c.ability===1247?0:1);
});
for(const c of conditionCases)test(`native seeded Grudge probability p${c.owner} ${c.condition} ${c.wheel_order}`,t=>{
  const errors=[];const probability=c.steps.find(s=>s.phase==='probability');
  const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(maximum,pokemon)=>{
    assert.equal(pokemon,c.target);const unit=probability.action.value.spins[0].results[0].num;assert(unit>=0&&unit<maximum);return unit;
  }});
  service.playOpponentTurn=()=>{};service.scheduleOpponentGrudge=()=>{};service.schedulePendingGrudge=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-native-grudge-condition');match.record=structuredClone(c.initial_record);match.turn=match.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
  // This is explicitly the native debug seed, not a claimed genesis history.
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
  for(const step of c.steps){
    if(step.phase==='probability')assert.equal(service.performPendingGrudge(match,match.pendingGrudge),true);
    else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    assert.deepEqual(errors,[]);checkState(service,match,step.status,step.phase);
  }
  assert.deepEqual(match.record.all_moves.filter(a=>a.value.type==='spin'),[probability.action],'one exact native probability spin, no condition displacement or battle disable');
  assert.equal(match.record.all_moves.some(a=>a.value.type==='disable_skill'),false);
  assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,1);
});

const transitCases=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/grudge-transit-contract.json',import.meta.url),'utf8')).cases;
for(const c of transitCases)test(`native Grudge transit p${c.owner} ${c.mode}`,t=>{
  const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0});service.playOpponentTurn=()=>{};service.scheduleOpponentGrudge=()=>{};
  service.rejectPlayerMove=(_m,reason)=>{errors.push(reason);return false;};
  const match=service.createMatch('isolated-grudge-transit');match.record=structuredClone(c.record);match.turn=match.record.first_player;match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
  service.preflightTurnRecord(match);const before=snapshot(match);
  const occupied={...c.action,value:{...c.action.value,route:c.action.value.route.slice(0,2)}};
  assert.equal(service.acceptPlayerMove(match,occupied,occupied.selective_side),false);assert.equal(snapshot(match),before);assert.deepEqual(errors,['illegal_player_movement']);errors.length=0;
  service.acceptPlayerMove(match,c.action,c.action.selective_side);
  if(!c.route_advertised){assert.deepEqual(errors,['illegal_player_movement']);assert.equal(snapshot(match),before);return;}
  assert.deepEqual(errors,[]);assert.equal(match.turn,c.status.turn);assert.equal(new Set(match.positions.values()).size,12);
  for(const p of c.status.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index)],[p.index,p.marker.circle,p.marker.triangle,p.wait]);
  // The native Sleep transit status retains the owner and has no TurnEnd.
  // v3 identifies the pending Touch/Null choice; all other accepted cases end.
  assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,c.effects.some(a=>a.value.type==='turn_end')?1:0);
});
