import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService} from './custom-match-engine.mjs';
const proof=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url)));

for(const entry of proof.cases) test(`native repeated-wheel action path: ${entry.name}`,async()=>{
  const expectedSpin=entry.record.all_moves.at(-1),queues=new Map(expectedSpin.value.spins.map(s=>[s.pokemon,s.results.map(r=>r.num)]));
  const writes=[],rejections=[],scheduledSecondary=[],scheduledRespin=[];
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,
    spinUnitSource:(range,pokemon)=>{assert.equal(range,96);return queues.get(pokemon)?.shift()??95;}});
  // Both actors are controlled by this test; only automatic opponent scheduling
  // is suppressed. Every movement, battle, spin and resolution uses real rules.
  service.playOpponentTurn=()=>{};
  // Pause only the timer so the native intermediate Both checkpoint can be
  // asserted before invoking the real secondary-spin transaction below.
  service.scheduleSecondarySpins=(_,pending)=>scheduledSecondary.push(pending);
  service.schedulePendingRespin=current=>scheduledRespin.push(current.pendingRespin);
  service.declareOpponentRespin=()=>{};
  service.rejectPlayerMove=(_,reason)=>rejections.push(reason);
  const match=service.createMatch('isolated-native-multispin');
  match.record=structuredClone(entry.record);match.record.all_moves=[];match.phase='started';
  match.plateState=null; // Initialize this new fixture from its actual equipment.
  match.socket={destroyed:false,write:value=>writes.push(value)};
  try {
    for(const action of entry.record.all_moves.slice(0,-1)) {
      service.acceptPlayerMove(match,structuredClone(action),action.selective_side);
      assert.deepEqual(rejections,[],'native-authorized action accepted');
    }
    for(let i=0;i<100&&match.battleResolutionPending&&!match.pendingSecondarySpins&&!match.pendingRespin;i++) await delay(5);
    const actual=match.record.all_moves.find(move=>move.value.type==='spin');
    assert.deepEqual(actual?.value,expectedSpin.value,'all individual battle/probability results retained in order');
    assert([...queues.values()].every(queue=>queue.length===0),'every native spin consumed');
    const checkState=(status,effects)=>{
      assert.equal(match.battleResolutionPending,!effects.some(effect=>effect.value.type==='turn_end'),'native resolution boundary');
      assert.equal(match.turn,status.turn);
      for(const pokemon of status.pokemon_conditions) {
        assert.equal(match.positions.get(pokemon.pokemon_index),pokemon.index,'native destination');
        assert.equal(match.conditions.get(pokemon.pokemon_index),pokemon.marker.circle,'native condition');
        assert.equal(match.waits.get(pokemon.pokemon_index),pokemon.wait,'native Wait');
        assert.equal(match.battledAfterField.get(pokemon.pokemon_index),pokemon.marker.battled_after_field_in,`native first-battle marker ${pokemon.pokemon_index}`);
      }
    };
    checkState(entry.status,entry.effects);
    for(const continuation of entry.continuations||[]) {
      const expected=continuation.record.all_moves.at(-1);
      if(expected.value.type==='spin') {
        for(const spin of expected.value.spins) queues.set(spin.pokemon,spin.results.map(result=>result.num));
        const pending=scheduledSecondary.shift();
        if(pending) service.performSecondarySpins(match,pending);
        else {assert.equal(scheduledRespin.shift(),match.pendingRespin);service.performPendingRespin(match);}
        assert.deepEqual(match.record.all_moves.filter(move=>move.value.type==='spin').at(-1).value,expected.value);
        assert([...queues.values()].every(queue=>queue.length===0));
        const before=JSON.stringify(match.record);
        if(pending) assert.equal(service.performSecondarySpins(match,pending),false,'duplicate secondary callback rejected');
        else service.performPendingRespin(match);
        assert.equal(JSON.stringify(match.record),before);
      } else {
        service.acceptPlayerMove(match,structuredClone(expected),expected.selective_side);
        assert.deepEqual(rejections,[]);
        assert.deepEqual(match.record.all_moves.filter(move=>move.value.type===expected.value.type).at(-1).value,expected.value);
      }
      checkState(continuation.status,continuation.effects);
    }
    assert.equal(new Set(match.positions.values()).size,12,'no overlap after resolution');
    assert(writes.some(line=>line.includes(' do_move ')&&line.includes('probability'))||expectedSpin.value.spins.every(s=>s.results.length===1));
  } finally {match.phase='finished';}
});
