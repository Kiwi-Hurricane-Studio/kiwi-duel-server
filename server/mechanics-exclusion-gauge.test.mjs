import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
import {turnStartGaugeAward} from './z-gauge-rules.mjs';
import {surroundingPlan} from './surrounding.mjs';

const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/exclusion-gauge-contract.json',import.meta.url),'utf8'));
const gauges=status=>Object.fromEntries(status.z_gauge_conditions.map(row=>[row.color,row.z_gauge]));
test('exclusion gauge expectations retain every original ARM request and response',()=>{
  assert.equal(contract.new_queries,225);assert.equal(contract.cases.length,27);
  for(const pin of contract.source_pins)assert.equal(createHash('sha256').update(readFileSync(pin.file)).digest('hex'),pin.sha256,pin.file);
  for(const c of contract.cases){
    const directory=new URL('./',new URL('file:///'+c.source.replaceAll('\\','/')));
    for(const step of c.steps){
      assert.deepEqual(JSON.parse(readFileSync(new URL(step.status_receipt,directory),'utf8')).status,step.status);
      assert.deepEqual(JSON.parse(readFileSync(new URL(step.effects_receipt,directory),'utf8')).effect_moves,step.effects);
    }
  }
});

for(const c of contract.cases)test(`native exclusion gauge through accepted MP and turn completion: ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('exclusion-gauge-private');
  match.record=structuredClone(c.record);match.record.all_moves=[];match.turn=c.before.turn;match.phase='started';
  match.positions=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.index]));
  match.conditions=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.marker.circle]));
  match.waits=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.wait]));match.zGauge=gauges(c.before);
  const errors=[],sent=[];match.socket={destroyed:false,write(){},destroy(){}};
  service.rejectPlayerMove=(_match,error)=>errors.push(error);service.sendSequenced=(_match,line)=>sent.push(line);service.playOpponentTurn=()=>{};
  const state=()=>JSON.stringify({record:match.record,ledger:match.completedTurnLedger,points:[...match.positions],waits:[...match.waits],gauge:match.zGauge});
  for(const [i,step]of c.steps.entries()){
    const count=match.record.all_moves.length;
    service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);assert.deepEqual(errors,[]);
    const emitted=match.record.all_moves.slice(count).filter(move=>move.value.type==='add_z_gauge').map(move=>move.value);
    assert.deepEqual(emitted,step.effects.filter(move=>move.value.type==='add_z_gauge').map(move=>move.value));
    assert.deepEqual(match.zGauge,gauges(step.status));assert.equal(match.turn,step.status.turn);
    for(const p of step.status.pokemon_conditions){assert.equal(match.positions.get(p.pokemon_index),p.index);assert.equal(match.conditions.get(p.pokemon_index),p.marker.circle);assert.equal(match.waits.get(p.pokemon_index),p.wait);}
    assert.equal(new Set(match.positions.values()).size,12);
    const ledger=inspectLedger(match.completedTurnLedger,match.record);assert(ledger.ok);assert.equal(ledger.state.completed_turns,i+1);
    const before=state();service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.equal(errors.pop(),'stale_player_turn');assert.equal(state(),before,'stale duplicate cannot repeat the bonus or completion');
  }
  assert.equal(sent.filter(line=>line.startsWith('do_move ')&&JSON.parse(line.slice(8)).value.type==='add_z_gauge').length,c.steps.length);
  match.phase='finished';
});

test('exclusion award is derived from current personal slots, separate from bench and P.C.',()=>{
  for(const side of ['black','white']){
    const owner=side==='black'?0:6,enemy=owner===0?6:0;
    assert.equal(turnStartGaugeAward(side,[[owner,44+owner],[enemy,44+enemy]]).deltas[side],7);
    for(const point of [28+owner,owner===0?40:42,owner===0?41:43,-1])assert.equal(turnStartGaugeAward(side,[[owner,point],[enemy,44+enemy]]).deltas[side],3);
    // An unrelated off-field slot must not be treated as that figure's removal.
    assert.equal(turnStartGaugeAward(side,[[owner,45+owner]]).deltas[side],3);
  }
});

test('Surround occupancy accepts personal exclusions and still rejects overlaps or unrelated slots',()=>{
  const c=contract.cases.find(row=>row.name==='v3-p0-b5-w5');
  const positions=new Map(c.before.pokemon_conditions.map(row=>[row.pokemon_index,row.index]));
  assert(surroundingPlan(c.record,positions,new Map(),[]).ok);
  for(const point of [45,55,56,59,44.5]){
    const invalid=new Map(positions);invalid.set(0,point);
    assert.equal(surroundingPlan(c.record,invalid,new Map(),[]).reason,'surround_invalid_occupancy');
  }
  const valid=new Map(positions);valid.set(0,44);assert(surroundingPlan(c.record,valid,new Map(),[]).ok);
});
