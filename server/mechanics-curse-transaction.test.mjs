import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';

const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/curse-transaction-contract.json',import.meta.url),'utf8'));
const single=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/curse-single-history-contract.json',import.meta.url),'utf8'));
contract.cases.push(...single.single_cases.filter(c=>c.spin));
contract.cases.push(...JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/curse-bench-cleanup-contract.json',import.meta.url),'utf8')).cases);
function checkState(match,status,label){
  assert.equal(match.turn,status.turn,label+' turn');
  for(const p of status.pokemon_conditions){
    assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index)],
      [p.index,p.marker.circle,p.marker.triangle,p.wait],label+' figure '+p.pokemon_index);
  }
  assert.equal(new Set(match.positions.values()).size,12,label+' occupancy');
  for(const row of status.z_gauge_conditions)assert.equal(match.zGauge[row.color],row.z_gauge,label+' gauge '+row.color);
}
for(const c of contract.cases.filter(c=>c.completed))test('native Curse transaction '+c.key,t=>{
  const errors=[];const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0,knockoutChoiceSource:()=>0});
  service.resolveBattle=()=>{};service.playOpponentTurn=()=>{};service.schedulePendingKnockouts=()=>{};
  service.rejectPlayerMove=(_match,reason)=>errors.push(reason);
  const match=service.createMatch('isolated-curse-transaction');match.record=structuredClone(c.record);match.phase='started';match.turn=c.record.first_player;
  match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};
  t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
  let next=0;
  const stage=service.stagePendingKnockouts.bind(service);
  service.stagePendingKnockouts=(m,state,outcome,targets)=>{
    const action=c.continuations[next]?.action;assert(action,'native automatic action is recorded');
    const v=action.value;
    let selected;
    if(v.type==='remove_pokemon')selected=v.pokemons[0];
    else if(v.type==='knockedout_move')selected=targets.find(x=>x.from===v.from)?.pokemon;
    else selected=targets.find(x=>m.triangles.get(x.pokemon)!=='curse' && (x.pokemon<6)===(v.type==='bench_move'?v.pokemon<6:v.from===41))?.pokemon;
    const index=targets.findIndex(x=>x.pokemon===selected);assert(index>=0);
    service.knockoutChoiceSource=n=>{assert(index<n);return index};
    return stage(m,state,outcome,targets);
  };
  service.acceptPlayerMove(match,c.action,c.action.selective_side);assert.deepEqual(errors,[]);
  const spinStart=match.record.all_moves.length;
  service.performBattleSpin(match,c.owner,c.enemy,c.action.selective_side);
  assert.deepEqual(errors,[]);checkState(match,c.post_spin,'post spin');
  const gaugeEffects=effects=>effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value);
  assert.deepEqual(gaugeEffects(match.record.all_moves.slice(spinStart)),gaugeEffects(c.spin_effects),'ordered spin gauge effects');
  for(const continuation of c.continuations){
    const pending=match.pendingKnockouts;assert(pending);assert.deepEqual(pending.firstMove,continuation.action);
    const snapshot=()=>JSON.stringify({positions:[...match.positions],conditions:[...match.conditions],triangles:[...match.triangles],waits:[...match.waits],moves:match.record.all_moves,gauge:match.zGauge,turn:match.turn});
    const before=snapshot();
    for(const invalid of [{...pending.firstMove,selective_side:'black'},{...pending.firstMove,value:{...pending.firstMove.value,unexpected:1}}]){
      assert.equal(service.performPendingKnockouts(match,pending,invalid),false);assert.equal(snapshot(),before);
    }
    assert.equal(service.performPendingKnockouts(match,{...pending}),false);assert.equal(snapshot(),before);
    const continuationStart=match.record.all_moves.length;
    ++next;assert.equal(service.performPendingKnockouts(match,pending,continuation.action),true);checkState(match,continuation.status,'continuation '+next);
    assert.deepEqual(gaugeEffects(match.record.all_moves.slice(continuationStart)),gaugeEffects(continuation.effects),'ordered continuation gauge effects');
    const after=snapshot();assert.equal(service.performPendingKnockouts(match,pending,continuation.action),false);assert.equal(snapshot(),after);
  }
  checkState(match,c.final_status,'final');assert.equal(match.pendingKnockouts,null);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,1);
});

for(const c of single.histories)test(`native genesis Curse application and exclusion, owner ${c.owner}`,t=>{
  const errors=[],units=[];
  for(const step of c.steps)if(step.action.value.type==='spin')for(const pokemon of [c.owner,c.enemy])units.push(step.action.value.spins.find(s=>s.pokemon===pokemon).results[0].num);
  const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:n=>{const unit=units.shift();assert(unit>=0&&unit<n);return unit}});
  service.resolveBattle=()=>{};service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,error)=>errors.push(error);
  const match=service.createMatch('isolated-native-curse-history');match.record=structuredClone(c.record);match.turn=c.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
  checkState(match,c.initial_status,'genesis');
  for(const [i,step] of c.steps.entries()){
    const count=match.record.all_moves.length;
    if(step.action.value.type==='spin')service.performBattleSpin(match,c.owner,c.enemy,c.record.first_player);
    else service.acceptPlayerMove(match,step.action,step.action.selective_side);
    assert.deepEqual(errors,[]);checkState(match,step.status,'history '+i);
    assert.deepEqual(match.record.all_moves.slice(count).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value));
  }
  assert.equal(match.positions.get(c.enemy),44+c.enemy);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,7);
});

for(const c of single.single_cases.filter(c=>!c.spin))test(`native cursed Surround, owner ${c.owner}`,t=>{
  const errors=[];const service=new CustomMatchService({port:0,clockSource:()=>0});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,error)=>errors.push(error);
  const match=service.createMatch('isolated-native-curse-surround');match.record=structuredClone(c.record);match.turn=c.record.first_player;match.phase='started';
  match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
  service.acceptPlayerMove(match,c.action,c.action.selective_side);
  assert.deepEqual(errors,[]);checkState(match,c.final_status,'native Surround');
  assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,1);
  assert.deepEqual(match.record.all_moves.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),c.spin_effects.filter(m=>m.value.type==='add_z_gauge').map(m=>m.value));
});

const coverage=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url),'utf8'));
const curseEntry=coverage.entries.find(e=>e.key==='skill:1479');
assert.equal(curseEntry.variants.length,4);assert.equal(curseEntry.variants.flatMap(v=>v.occurrences).length,6);
for(const variant of curseEntry.variants)for(const occurrence of variant.occurrences)for(const owner of [0,6])for(const defending of [false,true])for(const color of [1,3,4,2]){
  test(`authored Curse ${occurrence.figure_id}/${variant.range}, owner ${owner}, defending ${defending}, opposing color ${color}`,t=>{
    const c=single.single_cases.find(c=>c.owner===owner&&c.config.name==='curse_against_white');
    const errors=[],service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0});
    service.resolveBattle=()=>{};service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,error)=>errors.push(error);
    const match=service.createMatch('isolated-authored-curse');match.record=structuredClone(c.record);match.phase='started';
    const figures=match.record.players.flatMap(p=>p.pokemons),holder=figures.find(p=>p.pokemon_index===owner),enemy=figures.find(p=>p.pokemon_index===c.enemy);
    holder.id=occurrence.figure_id;holder.skills=[{id:1479,color:2,range:variant.range,speed_or_damage:variant.stars},{id:1131,color:0,range:96-variant.range,speed_or_damage:0}];
    enemy.skills=[{id:color===2?1479:color===4?1122:color===3?1413:1199,color,range:96,speed_or_damage:color===2?1:color===4?0:50}];
    const action=structuredClone(c.action);
    if(defending){action.selective_side=owner===0?'white':'black';action.value.from_pokemon=c.enemy;action.value.to_pokemon=owner;}
    match.record.first_player=action.selective_side;match.turn=action.selective_side;
    match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};t.after(()=>{match.phase='finished'});
    for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);}
    service.acceptPlayerMove(match,action,action.selective_side);
    service.performBattleSpin(match,action.value.from_pokemon,action.value.to_pokemon,action.selective_side);
    assert.deepEqual(errors,[]);assert.equal(match.triangles.get(c.enemy),color===1?'curse':'empty');assert.equal(match.triangles.get(owner),'empty');
    assert.equal(new Set(match.positions.values()).size,12);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,1);
  });
}
