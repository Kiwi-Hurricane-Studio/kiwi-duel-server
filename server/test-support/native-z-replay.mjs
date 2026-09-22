// Test-only native receipt reader and production-engine replay. No devices,
// accounts, live sockets, state hydration, or default Godot profiles.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CustomMatchService,customMatchTestHooks as hooks} from '../custom-match-engine.mjs';

const root=new URL('../../',import.meta.url);
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function nativeArchive(relative,expectedManifestHash){
  const directory=new URL(relative+'/',root),bytes=readFileSync(new URL('manifest.json',directory));
  if(expectedManifestHash)assert.equal(hash(bytes),expectedManifestHash);
  const manifest=JSON.parse(bytes);
  assert.equal(manifest.complete,true);assert.equal(manifest.live_match_commands,0);
  const chain=[],seen=new Set(),evidence=fileURLToPath(new URL('docs/generated/',root));
  function parentChain(file,m){
    const absolute=fileURLToPath(file);assert.ok(!seen.has(absolute),'acyclic archive chain');seen.add(absolute);
    if(m.resume_parent){
      const parent=path.resolve(m.resume_parent.manifest),relative=path.relative(evidence,parent);
      assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'parent stays in generated evidence');
      const payload=readFileSync(parent);assert.equal(hash(payload),m.resume_parent.sha256);
      const prior=JSON.parse(payload);
      assert.equal(prior.complete,false);assert.equal(prior.paused,true);assert.ok(!prior.error);
      assert.equal(prior.source_unchanged,true);assert.equal(prior.script_unchanged,true);
      assert.equal(m.case_name,prior.case_name);assert.equal(m.script_sha256,prior.script_sha256);
      assert.equal(m.source_manifest_sha256,prior.source_manifest_sha256);
      assert.deepEqual(m.controls,prior.controls);assert.equal(m.resume_parent.next_step,prior.resume_next_step);
      parentChain(pathToFileURL(parent),prior);
    }
    assert.equal(m.device,'emulator-5554');assert.equal(m.avd,'ExecutionAtlas_API28_X86');assert.equal(m.live_match_commands,0);
    chain.push({manifest:m,directory:new URL('./',file)});
  }
  parentChain(new URL('manifest.json',directory),manifest);
  const pairs=new Map(),queries=[];
  let expectedRecord=null,operationCount=0;
  for(const entry of chain){
  const localPairs=new Map(entry.manifest.queries.map(query=>{
    const pair={query};
    for(const kind of ['request','response']){
      assert.ok(!/[\\/]/.test(query[kind+'_file']));
      const payload=readFileSync(new URL(query[kind+'_file'],entry.directory));
      assert.equal(hash(payload),query[kind+'_sha256']);pair[kind]=JSON.parse(payload);
    }
    assert.equal(query.exit_code,0);
    assert.equal(pair.request.cmd,query.operation);assert.equal(pair.response.cmd,query.operation);assert.ok(!pair.response.error);
    assert.equal(hash(JSON.stringify(pair.request.record)),query.record_sha256);
    assert.ok(!pairs.has(query.sequence),'unique receipt across windows');pairs.set(query.sequence,pair);queries.push(query);
    return [query.sequence,pair];
  }));
  for(const item of entry.manifest.cases)for(const action of item.actions){
    const legal=localPairs.get(action.legal_query_sequence);assert.ok(legal);
    assert.ok(legal.response.legal_moves.some(candidate=>JSON.stringify(candidate)===JSON.stringify(action.move)));
    assert.equal(hash(JSON.stringify(legal.request.record)),action.before_record_sha256);
    const next=structuredClone(legal.request.record);next.all_moves.push(action.move);
    assert.equal(hash(JSON.stringify(next)),action.after_record_sha256);
  }
  if(chain.length>1){
    if(entry.manifest.resume_parent)assert.equal(entry.manifest.resume_parent.next_step,operationCount);
    for(const {request,query} of localPairs.values()){
      expectedRecord??=structuredClone(request.record);
      assert.deepEqual(request.record,expectedRecord,'continuous exact accepted record across queries/windows');
      const actions=entry.manifest.cases.flatMap(item=>item.actions).filter(action=>action.legal_query_sequence===query.sequence);
      assert.ok(actions.length<=1);if(actions.length)expectedRecord.all_moves.push(actions[0].move);
      operationCount++;
    }
    if(entry.manifest.paused){
      assert.equal(entry.manifest.resume_next_step,operationCount);
      const resume=readFileSync(new URL('resume-record.json',entry.directory));
      assert.equal(hash(resume),entry.manifest.resume_record_sha256);
      assert.deepEqual(JSON.parse(resume).record,expectedRecord,'paused record equals complete accepted history');
    }
  }
  }
  return {manifest,manifests:chain.map(entry=>entry.manifest),pairs,get(label,operation='status'){
    const query=queries.find(q=>q.label===label&&q.operation===operation);assert.ok(query,label+'/'+operation);
    return pairs.get(query.sequence);
  }};
}

export async function replayNativeZ(t,record){
  const errors=[],units=[],writes=[];
  let declaration;
  for(const action of record.all_moves){
    if(action.value.type==='declare_battle')declaration=action;
    if(action.value.type==='spin')for(const actor of [declaration.value.from_pokemon,declaration.value.to_pokemon]){
      units.push(action.value.spins.find(row=>row.pokemon===actor).results[0].num);
    }
  }
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,
    spinUnitSource:maximum=>{const n=units.shift();assert.ok(Number.isInteger(n)&&n>=0&&n<maximum);return n;}});
  service.playOpponentTurn=()=>{};service.resolveBattle=()=>{};service.schedulePendingKnockouts=()=>{};
  const match=service.createMatch('private-native-z-full-prefix');match.phase='started';
  match.socket={write:line=>writes.push(line),destroy:error=>errors.push(error.message)};
  t.after(()=>{match.phase='finished';});
  // Authored definitions before the empty initial record only. Every gauge,
  // position, condition, Wait and transaction must derive from accepted moves.
  for(const player of match.record.players){
    const source=record.players.find(row=>row.color===player.color);
    player.pokemons=structuredClone(source.pokemons);player.plates=[...source.plates];
  }
  const definitions=structuredClone(match.record.players);
  const result={service,match,errors,writes,lastState:null,lastOutcome:null,lastBattleGauge:[],beforeTurn:null,lastSteps:null};
  const finish=service.finishBattleSpin.bind(service);
  service.finishBattleSpin=(...args)=>{result.lastState=structuredClone(args[1]);return finish(...args);};
  const apply=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const outcome=apply(...args);result.lastOutcome=outcome;result.beforeTurn=new Map(match.waits);return outcome;};
  const knockout=service.completeKnockoutBatch.bind(service);
  service.completeKnockoutBatch=(...args)=>{result.lastSteps=structuredClone(args[3]);return knockout(...args);};
  declaration=null;
  for(const action of record.all_moves){
    if(action.value.type==='spin'){
      const before=match.record.all_moves.length;
      CustomMatchService.prototype.resolveBattle.call(service,match,declaration);
      const deadline=Date.now()+2000;
      while(!match.record.all_moves.slice(before).some(a=>a.value.type==='spin')){
        assert.ok(Date.now()<deadline,'production scheduled spin completed');
        await new Promise(resolve=>setTimeout(resolve,1));
      }
      result.lastBattleGauge=match.record.all_moves.slice(before).filter(a=>a.value.type==='add_z_gauge').map(a=>a.value);
      declaration=null;
    }else if(action.selective_side==='both'&&['spot_move','knockedout_move'].includes(action.value.type)){
      assert.equal(service.performPendingKnockouts(match,match.pendingKnockouts,action),true);
    }else{
      service.acceptPlayerMove(match,action,action.selective_side);
      if(action.value.type==='declare_battle')declaration=action;
    }
    assert.deepEqual(errors,[],`production rejects native ${action.value.type}`);
  }
  assert.equal(units.length,0);assert.deepEqual(match.record.players,definitions,'ordinary record wheels remain immutable');
  return result;
}
export function compareNativeZStatus(match,status){
  assert.equal(match.turn,status.turn);
  assert.deepEqual(match.zGauge,Object.fromEntries(status.z_gauge_conditions.map(row=>[row.color,row.z_gauge])));
  for(const row of status.pokemon_conditions){
    assert.equal(match.positions.get(row.pokemon_index),row.index,'native figure '+row.pokemon_index+' position');
    assert.equal(match.waits.get(row.pokemon_index),row.wait,'native figure '+row.pokemon_index+' Wait');
    assert.equal(match.conditions.get(row.pokemon_index),row.marker.circle,'native condition');
    assert.equal(hooks.ensureZState(match).active?.pokemon===row.pokemon_index,Boolean(row.marker.z_state),'native Z marker');
  }
}
