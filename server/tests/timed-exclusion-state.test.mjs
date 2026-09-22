import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as Reducer from '../timed-exclusion-state.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=JSON.parse(fs.readFileSync(path.join(project,'tests/fixtures/timed_exclusion_v1.json')));
const copy=v=>structuredClone(v);
const sha=b=>createHash('sha256').update(b).digest('hex');
const must=r=>{assert.equal(r.ok,true,r.reason);return r;};
function start(native=fixture.native) {
  const record=copy(native.record),positions=copy(native.initial_positions),input=copy(native.input);
  const created=must(Reducer.createState(record,positions));
  const begun=must(Reducer.begin1692Removal(created.state,input,positions,record));
  return {record,positions,input,created,begun};
}
function step(current,record,round) {
  const n=fixture.native.rounds[round],positions=copy(n.positions);positions[0]=44;
  return must(Reducer.advanceCompletedTurn(current.state,n.boundary,positions,record));
}
test('all exact fixed public native bytes and canonical vectors are bound',()=>{
  assert.equal(fixture.schema,'kiwi-timed-exclusion-shared-fixture-1');
  assert.equal(fixture.native.bindings.length,43);
  for(const b of fixture.native.bindings){
    assert.match(b.file,/^docs\/generated\/z-rule-continuation-20260913\/native-expiry-204015\/[A-Za-z0-9_-]+\.json$/);
    assert.equal(sha(fs.readFileSync(path.join(project,b.file))),b.sha256);
  }
  const sourceBase='docs/generated/z-rule-continuation-20260913/native-expiry-204015/';
  const manifest=JSON.parse(fs.readFileSync(path.join(project,sourceBase+'manifest.json')));
  const sourceQuery=(round,operation)=>{
    const rows=manifest.queries.filter(q=>q.label===`expiry-r${round}-c0`&&q.operation===operation);assert.equal(rows.length,1);
    const row=rows[0],out={};
    for(const kind of ['request','response']){
      const file=sourceBase+row[kind+'_file'];assert.ok(fixture.native.bindings.some(b=>b.file===file&&b.sha256===row[kind+'_sha256']));
      out[kind]=JSON.parse(fs.readFileSync(path.join(project,file)));
    }return out;
  };
  assert.deepEqual(fixture.native.record,sourceQuery(0,'status').request.record);
  assert.deepEqual(fixture.native.actions,manifest.cases[0].actions.map(a=>a.move));
  let reconstructed=copy(fixture.native.record);
  for(let r=0;r<7;r++){
    if(r)reconstructed.all_moves.push(copy(fixture.native.actions[r-1]));
    const status=sourceQuery(r,'status'),effects=sourceQuery(r,'output_effects'),legal=sourceQuery(r,'legal_moves'),round=fixture.native.rounds[r];
    for(const q of [status,effects,legal])assert.deepEqual(q.request.record,reconstructed);
    assert.deepEqual(round.positions,status.response.status.pokemon_conditions.map(p=>p.index));
    assert.equal(round.remove_duration,status.response.status.pokemon_conditions.find(p=>p.pokemon_index===0).marker.remove_duration);
    assert.deepEqual(round.removal_effects,effects.response.effect_moves.filter(e=>e.value.type==='remove_pokemon_with_duration'));
    assert.deepEqual(round.return_effects,effects.response.effect_moves.filter(e=>e.value.type==='bench_move'));
    assert.equal(round.raw_record_sha256,sha(JSON.stringify(reconstructed)));
    assert.equal(round.canonical_record_sha256,Reducer.canonicalDigest(reconstructed));
    assert.equal(round.record_move_count,reconstructed.all_moves.length);
    assert.deepEqual(round.boundary,{kind:r?'nonbattle_mp_move':'resolved_battle',ended_side:r%2?'black':'white'});
  }
  const initial=copy(fixture.native.rounds[0].positions);
  assert.deepEqual(fixture.native.record.all_moves.at(-5).value.route,[27,20,15]);initial[0]=15;
  assert.deepEqual(fixture.native.initial_positions,initial);
  assert.deepEqual(fixture.native.input,{pokemon:0,actor:7,skill_id:1692,duration:7,victim_condition:'normal',victim_wait:0,actor_condition:'normal',actor_wait:0});
  for(const actor of [0,7]){const condition=sourceQuery(0,'status').response.status.pokemon_conditions.find(p=>p.pokemon_index===actor);assert.equal(condition.wait,0);assert.equal(condition.marker.circle,'normal');}
  for(const v of fixture.canonical_vectors){assert.equal(Reducer.canonicalToken(v.value),v.token);assert.equal(Reducer.canonicalDigest(v.value),v.sha256);}
  assert.equal(Reducer.canonicalDigest({a:1,z:2}),Reducer.canonicalDigest({z:2,a:1}));
  assert.notEqual(Reducer.canonicalDigest('000042'),Reducer.canonicalDigest('42'));
});
test('native full-prefix expiry/effects and every duplicate boundary',()=>{
  const s=start();let current=s.begun;
  assert.deepEqual(current.effects,fixture.native.rounds[0].removal_effects);
  assert.equal(current.state.timed.remaining,7);
  for(let round=0;round<7;round++) {
    const n=fixture.native.rounds[round];if(round)s.record.all_moves.push(copy(fixture.native.actions[round-1]));
    assert.equal(Reducer.canonicalDigest(s.record),n.canonical_record_sha256);
    assert.equal(sha(JSON.stringify(s.record)),n.raw_record_sha256);
    const previous=current,before=copy(previous);current=step(previous,s.record,round);assert.deepEqual(previous,before);
    assert.deepEqual(current.positions,n.positions);assert.deepEqual(current.effects,n.return_effects);
    const snapshot=must(Reducer.snapshot(current.state,current.positions,s.record));
    assert.equal(snapshot.figures[0].remove_duration,n.remove_duration);assert.equal(snapshot.runtime_integrated,false);
    assert.equal(current.effects.some(e=>['knockedout_move','add_z_gauge'].includes(e.value.type)),false);
    const duplicate=must(Reducer.advanceCompletedTurn(current.state,{ended_side:n.boundary.ended_side,kind:n.boundary.kind},current.positions,s.record));
    assert.equal(duplicate.changed,false);assert.deepEqual(duplicate.state,current.state);assert.deepEqual(duplicate.effects,[]);
  }
  assert.equal(current.state.timed,null);assert.equal(current.positions[0],28);
  assert.equal(s.positions[0],15);assert.equal(s.created.state.timed,null);
});
test('every JSON reconnect checkpoint yields identical continuation',()=>{
  const results=[];
  for(let restore=-1;restore<7;restore++) {
    const s=start();let current=s.begun;
    for(let round=0;round<7;round++) {
      if(round)s.record.all_moves.push(copy(fixture.native.actions[round-1]));
      if(round-1===restore)current=JSON.parse(JSON.stringify(current));
      current=step(current,s.record,round);
    }results.push(current);
  }
  for(const r of results)assert.deepEqual(r,results[0]);
});
test('untimed disposition preserved independently through timed expiry',()=>{
  const n=copy(fixture.native),p=copy(n.initial_positions);p[2]=46;
  let current=must(Reducer.createState(n.record,p,[2]));current=must(Reducer.begin1692Removal(current.state,n.input,p,n.record));
  for(let r=0;r<7;r++) {
    if(r)n.record.all_moves.push(copy(n.actions[r-1]));
    current=must(Reducer.advanceCompletedTurn(current.state,n.rounds[r].boundary,current.positions,n.record));
    assert.equal(current.positions[2],46);assert.deepEqual(current.state.untimed,[2]);
    const snap=must(Reducer.snapshot(current.state,current.positions,n.record));
    assert.equal(snap.figures[2].disposition,'untimed');assert.equal(snap.figures[2].remove_duration,-1);
  }
});
test('shared synthetic mirrored/Unicode/untimed case is math only',()=>{
  for(const f of fixture.synthetic_runs){
    const record=copy(f.record);let current=must(Reducer.createState(record,f.initial_positions,f.untimed));
    current=must(Reducer.begin1692Removal(current.state,f.input,current.positions,record));
    for(let round=0;round<7;round++){
      let ended_side='black';
      if(round){const move=copy(f.actions[round-1]);record.all_moves.push(move);ended_side=move.selective_side;
        const moving=current.positions.indexOf(move.value.route[0]);assert.ok(moving>=0);current.positions[moving]=move.value.route.at(-1);}
      current=must(Reducer.advanceCompletedTurn(current.state,{kind:round?'nonbattle_mp_move':'resolved_battle',ended_side},current.positions,record));
      const snapshot=must(Reducer.snapshot(current.state,current.positions,record));
      assert.equal(snapshot.figures[7].remove_duration,f.expected_remove_durations[round]);
      assert.equal(snapshot.figures[2].disposition,'untimed');assert.equal(snapshot.figures[2].remove_duration,-1);assert.equal(current.positions[2],46);
    }
    assert.equal(current.positions[7],f.expected_return_point);
  }
});
for(const [label,mutate] of [
  ['extra state field',v=>v.state.extra=0],['wrong schema',v=>v.state.schema=1],
  ['extra input field',v=>v.input.extra=0],['same side',v=>v.input.actor=1],
  ['string actor',v=>v.input.actor='7'],['wait bool',v=>v.input.victim_wait=false],
  ['condition nonneutral',v=>v.input.victim_condition='poison'],['positive wait',v=>v.input.actor_wait=1],
  ['nonfinite wait',v=>v.input.victim_wait=NaN],['wrong duration',v=>v.input.duration=6],
  ['position overlap',v=>v.positions[1]=15],['foreign personal bench',v=>v.positions[1]=28],
  ['PC unsupported',v=>v.positions[1]=40],['untracked exclusion',v=>v.positions[2]=46],
  ['extra position',v=>v.positions.push(12)],['fractional position',v=>v.positions[1]=1.5],
  ['foreign match',v=>v.record.id='2'],['actor definition mutation',v=>v.record.players[1].pokemons[1].id++],
  ['actor index mutation',v=>v.record.players[1].pokemons[1].pokemon_index=0],
  ['declaration foreign actor',v=>v.record.all_moves.at(-2).value.from_pokemon=8],
  ['duplicate spin actor',v=>v.record.all_moves.at(-1).value.spins[0].pokemon=7],
]) test(`begin rejects ${label} atomically`,()=>{
  const s=start();const v={state:copy(s.created.state),positions:copy(s.positions),input:copy(s.input),record:copy(s.record)};mutate(v);
  const before=copy(v),r=Reducer.begin1692Removal(v.state,v.input,v.positions,v.record);assert.equal(r.ok,false);assert.deepEqual(v,before);
});
for(const [label,mutate] of [
  ['unknown boundary',v=>v.boundary.kind='plate'],['gauge boundary',v=>v.boundary.kind='add_z_gauge'],
  ['extra boundary field',v=>v.boundary.clock=1],['foreign ended side',v=>v.boundary.ended_side='black'],
  ['timer corruption',v=>v.state.timed.remaining=5],['extra timed key',v=>v.state.timed.extra=0],
  ['creation schema mutation',v=>v.state.timed.cause.schema='wrong'],['creation hash mutation',v=>v.state.timed.cause.record_sha256='0'.repeat(64)],
  ['historical move mutation',v=>v.record.all_moves[0].selective_side='foreign'],
  ['excluded victim relocated',v=>v.positions[0]=28],['untimed duplicate',v=>v.state.untimed=[2,2]],
  ['creation index boolean',v=>v.state.timed.cause.record_index=true],
]) test(`advance rejects ${label} atomically`,()=>{
  const s=start(),v={state:s.begun.state,positions:s.begun.positions,record:s.record,boundary:copy(fixture.native.rounds[0].boundary)};mutate(v);
  const before=copy(v);assert.equal(Reducer.advanceCompletedTurn(v.state,v.boundary,v.positions,v.record).ok,false);assert.deepEqual(v,before);
});
test('stale/skipped/nonalternating callbacks and reapplication are fail closed',()=>{
  const s=start();let current=step(s.begun,s.record,0),before=copy(current);
  assert.equal(Reducer.begin1692Removal(current.state,s.input,current.positions,s.record).ok,false);
  const skip=copy(s.record);skip.all_moves.push(...copy(fixture.native.actions.slice(0,2)));
  assert.equal(Reducer.advanceCompletedTurn(current.state,fixture.native.rounds[2].boundary,current.positions,skip).ok,false);
  const bad=copy(s.record);bad.all_moves.push(copy(fixture.native.actions[0]));bad.all_moves.at(-1).selective_side='white';
  assert.equal(Reducer.advanceCompletedTurn(current.state,{kind:'nonbattle_mp_move',ended_side:'white'},current.positions,bad).ok,false);
  assert.deepEqual(current,before);
  s.record.all_moves.push(copy(fixture.native.actions[0]));current=step(current,s.record,1);
  const old=copy(s.record);old.all_moves.pop();assert.equal(Reducer.advanceCompletedTurn(current.state,fixture.native.rounds[0].boundary,current.positions,old).ok,false);
});
test('known prior MP boundary survives intervening selection/declaration/spin without an extra tick',()=>{
  const s=start(),prefix=copy(s.record);prefix.all_moves=prefix.all_moves.slice(0,-4);
  assert.equal(prefix.all_moves.at(-1).selective_side,'black');
  const prior=must(Reducer.advanceCompletedTurn(s.created.state,{kind:'nonbattle_mp_move',ended_side:'black'},s.positions,prefix));
  const begun=must(Reducer.begin1692Removal(prior.state,s.input,prior.positions,s.record));
  assert.equal(begun.state.timed.remaining,7);
  const after=must(Reducer.advanceCompletedTurn(begun.state,fixture.native.rounds[0].boundary,begun.positions,s.record));
  assert.equal(after.state.timed.remaining,6);
});
test('non-JSON host values reject without invoking getters',()=>{
  for(const value of [NaN,Infinity,1.25,undefined,()=>{},new Date(),new Map(),[,,],{v:NaN},'\ud800'])assert.throws(()=>Reducer.canonicalToken(value));
  let called=false;const value={};Object.defineProperty(value,'x',{enumerable:true,get(){called=true;return 1;}});
  assert.throws(()=>Reducer.canonicalToken(value));assert.equal(called,false);
});
test('restored actor and victim remain bound to original declaration/spin',()=>{
  for(const change of ['actor','victim']){
    const s=start();
    if(change==='actor')s.begun.state.timed.actor=8;
    else {s.begun.state.timed.pokemon=1;s.begun.state.timed.point=45;s.begun.positions[0]=15;s.begun.positions[1]=45;}
    const before=copy(s);
    assert.equal(Reducer.snapshot(s.begun.state,s.begun.positions,s.record).ok,false);
    assert.equal(Reducer.advanceCompletedTurn(s.begun.state,fixture.native.rounds[0].boundary,s.begun.positions,s.record).ok,false);
    assert.deepEqual(s,before);
  }
});
test('malformed JSON primitives are rejected on every typed state/cause/input field',()=>{
  const s=start();
  for(const value of [null,false,true,'',[],{}]){
    for(const field of ['schema','match_id','definition_sha256']){
      const state=copy(s.begun.state);state[field]=copy(value);const before=copy(state);
      assert.equal(Reducer.snapshot(state,s.begun.positions,s.record).ok,false);assert.deepEqual(state,before);
    }
    for(const field of ['point','remaining','pokemon','actor','skill_id','origin_point']){
      const state=copy(s.begun.state);state.timed[field]=copy(value);const before=copy(state);
      assert.equal(Reducer.snapshot(state,s.begun.positions,s.record).ok,false);assert.deepEqual(state,before);
    }
    for(const field of ['schema','match_id','definition_sha256','record_index','record_move_count','record_sha256','kind','ended_side']){
      const state=copy(s.begun.state);state.timed.cause[field]=copy(value);const before=copy(state);
      assert.equal(Reducer.snapshot(state,s.begun.positions,s.record).ok,false);assert.deepEqual(state,before);
    }
    for(const field of ['victim_condition','actor_condition','skill_id','duration']){
      const input=copy(s.input);input[field]=copy(value);const before=copy(input);
      assert.equal(Reducer.begin1692Removal(s.created.state,input,s.positions,s.record).ok,false);assert.deepEqual(input,before);
    }
  }
});
