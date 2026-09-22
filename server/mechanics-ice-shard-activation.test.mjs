import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
const cases=['ice-shard-activation-contract-v2.json','ice-shard-purple-cleanup-contract.json','ice-shard-spatial-order-contract.json'].flatMap(f=>JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/'+f,import.meta.url),'utf8')).cases);
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],triangles:[...m.triangles],waits:[...m.waits],battled:[...m.battledAfterField],ledger:m.completedTurnLedger,gauge:m.zGauge});
for(const c of cases)test(`native Ice Shard activation ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const errors=[],queues=new Map(),service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:(range,p)=>{assert.equal(range,96);const v=queues.get(p)?.shift();assert(Number.isInteger(v),'only original observed spins are consumed');return v}});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,e)=>{errors.push(e);return false};
  const match=service.createMatch('isolated-native-ice-shard-activation');match.record=structuredClone(c.record);match.turn=c.seeded_status.turn;match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  for(const p of c.seeded_status.pokemon_conditions){match.positions.set(p.pokemon_index,p.index);match.conditions.set(p.pokemon_index,p.marker.circle);match.triangles.set(p.pokemon_index,p.marker.triangle);match.waits.set(p.pokemon_index,p.wait);match.battledAfterField.set(p.pokemon_index,p.marker.battled_after_field_in);}
  service.preflightTurnRecord(match);
  for(const [index,step] of c.steps.entries()){
    const start=match.record.all_moves.length;
    if(step.action.value.type==='spin'){
      for(const s of step.action.value.spins)queues.set(s.pokemon,s.results.map(r=>r.num));
      if(step.action.value.spins.every(s=>s.results.every(r=>r.type==='probability'))){
        const pending=match.pendingSecondarySpins;assert(pending,'native follow-up is pending');assert.equal(service.performSecondarySpins(match,pending),true);
        const saved=snapshot(match);assert.equal(service.performSecondarySpins(match,pending),false);assert.equal(snapshot(match),saved,'duplicate callback cannot replay secondary effects');
      }else{const v=c.steps[0].action.value;service.performBattleSpin(match,v.from_pokemon,v.to_pokemon,c.steps[0].action.selective_side,match.activeBattleDeclaration);}
      assert.deepEqual(match.record.all_moves.filter(m=>m.value.type==='spin').at(-1).value,step.action.value,'every original wheel result retained');assert([...queues.values()].every(q=>q.length===0));
      const declares=step.effects.filter(e=>e.value.type==='declare_spin');
      if(declares.length){assert(match.pendingSecondarySpins);assert.deepEqual(match.pendingSecondarySpins.outcome.secondarySpins.map(p=>p.targets),declares.map(e=>e.value.pokemons),'native radius and target ordering');}
      else assert.equal(match.pendingSecondarySpins,null,'inactive or finished follow-up');
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[]);assert.equal(match.turn,step.status.turn);
    if(step.status.selective_side==='both')assert(match.battleResolutionPending,'automatic Spin owns Both');else assert.equal(service.selectionSide(match),step.status.selective_side);
    for(const p of step.status.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],[p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name}/${index} figure ${p.pokemon_index}`);
    assert.equal(new Set(match.positions.values()).size,12);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
    assert.deepEqual(match.record.all_moves.slice(start).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(e=>e.value.type==='add_z_gauge').map(e=>e.value),'native ordered gauge receipts');
  }
  assert.equal(match.battleResolutionPending,false);assert.equal(match.pendingSecondarySpins,null);assert.equal(match.pendingJump,null);
});
