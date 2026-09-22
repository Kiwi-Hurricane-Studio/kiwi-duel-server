import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {HumanMatchService} from './human-match-service.mjs';
import {customMatchContract} from './custom-match-engine.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const godot=process.env.DUEL_TEST_GODOT||path.join(project,'.tools/godot/Godot_v4.7.2-stable_win64.exe');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archive=path.join(project,'docs/generated/z1715-integration-20260911/native-white');
const manifest=JSON.parse(fs.readFileSync(path.join(archive,'manifest.json')));
const query=manifest.queries.find(q=>q.label==='white-resolved0'&&q.operation==='status');
const requestBytes=fs.readFileSync(path.join(archive,query.request_file));
const responseBytes=fs.readFileSync(path.join(archive,query.response_file));
assert.equal(sha(requestBytes),query.request_sha256);assert.equal(sha(responseBytes),query.response_sha256);
const nativeRecord=JSON.parse(requestBytes).record;
const nativeStatus=JSON.parse(responseBytes).status;
assert.equal(sha(JSON.stringify(nativeRecord)),query.record_sha256);

test('two actual Godot TCP clients execute full native1715 prefix and restore every active phase',{
 timeout:90000,skip:!fs.existsSync(godot)?'Godot runtime unavailable':false,
},async t=>{
 const privateRoot=fs.mkdtempSync(path.join(os.tmpdir(),'kiwi-core-tests-z1715-'));
 const evidence=fs.mkdtempSync(path.join(project,'docs/generated/z1715-integration-20260911/client/real-tcp-'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(DUEL_|GODOT_|KIWI_|PYTHON|XDG_|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)));
 for(const [key,leaf]of Object.entries({APPDATA:'roaming',LOCALAPPDATA:'local',XDG_DATA_HOME:'xdg-data',XDG_CONFIG_HOME:'xdg-config',XDG_CACHE_HOME:'xdg-cache',TEMP:'temp',TMP:'temp'})){env[key]=path.join(privateRoot,leaf);fs.mkdirSync(env[key],{recursive:true});}
 env.KIWI_PRIVATE_TEST_ROOT=privateRoot;
 const users=[{user_id:701,display_name:'Z_First_Test'},{user_id:702,display_name:'Z_Second_Test'}];
 const sessions=users.map(()=>randomUUID());const privateValues=[...sessions];
 const decks=customMatchContract.decks.map((entries,index)=>({deck_no:index+1,figures:entries.map((entry,slot)=>({deck_index:slot,item_master_id:entry.itemMasterId,model_id:entry.modelId})),plates:[5002,5015,5022,5023,5026,5426]}));
 const finalSpin=nativeRecord.all_moves.at(-1);assert.equal(finalSpin.value.type,'spin');
 const units=[6,0].map(actor=>finalSpin.value.spins.find(row=>row.pokemon===actor).results[0].num);
 const service=new HumanMatchService({bindHost:'127.0.0.1',publicHost:'127.0.0.1',port:0,moveDelayMs:1,
  clockSource:()=>1800000000000,firstPresentationMs:0,turnPresentationMs:0,presentationSlackMs:0,
  battlePresentationMs:0,battleWheelPresentationMs:0,
  authenticateSession:session=>users[sessions.indexOf(session)]??null,
  spinUnitSource:maximum=>{const value=units.shift();assert.ok(value>=0&&value<maximum);return value;}});
 let child,stdout='',stderr='',closed=false,proof=null,adapterError='',held=null;
 const resolveBattle=service.resolveBattle.bind(service);
 service.resolveBattle=(...args)=>{assert.equal(held,null);held=args;};
 const sources=['src/domain/match_z_state.gd','src/domain/match_move_planner.gd','src/services/battle_client.gd','src/ui/match_stage_view.gd','tests/z1715_connection_runner.gd','server/custom-match-engine.mjs','server/human-match-service.mjs'];
 const hashes=()=>Object.fromEntries(sources.map(file=>[file,sha(fs.readFileSync(path.join(project,file)))]));
 const before=hashes();
 const ticketCounts=[0,0];
 let match;
 try{
  await service.listen();
  service.enter(sessions[0],users[0],decks[0]);
  const found=service.enter(sessions[1],users[1],decks[1]);
  match=service.matches.get(found.room_id);
  // Controlled authored definitions before either initial PlayGame only.
  // Positions/Wait/gauges/record/Z transaction are not injected or hydrated.
  for(const player of match.record.players){const original=nativeRecord.players.find(p=>p.color===player.color);player.pokemons=structuredClone(original.pokemons);player.plates=[...original.plates];}
  const initialDefinitions=structuredClone(match.record.players);
  const fixture={expected_status:nativeStatus,users,statuses:users.map((user,index)=>service.poll(sessions[index],user)),actions:nativeRecord.all_moves};
  const fixturePath=path.join(privateRoot,'fixture.json');fs.writeFileSync(fixturePath,JSON.stringify(fixture));
  child=spawn(godot,['--headless','--path',project,'--quit-after','12000','--log-file',path.join(privateRoot,'engine.log'),
   '--script','res://tests/z1715_connection_runner.gd','--','--expected-user-root='+privateRoot,'--z-fixture='+fixturePath],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let lines='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;lines+=chunk;
   while(lines.includes('\n')){const end=lines.indexOf('\n'),line=lines.slice(0,end).trim();lines=lines.slice(end+1);
    try{
     if(line.startsWith('GODOT_Z_TICKET_REQUEST=')){
      const request=JSON.parse(line.slice('GODOT_Z_TICKET_REQUEST='.length));
      assert.ok([0,1].includes(request.side));assert.equal(request.request_id,++ticketCounts[request.side]);assert.ok(request.request_id<=4);
      const ticket=service.issueTicket(sessions[request.side],users[request.side]);privateValues.push(ticket);
      const ticketPath=path.join(privateRoot,`ticket-${request.side}-${request.request_id}.json`);
      fs.writeFileSync(ticketPath+'.tmp',JSON.stringify({ticket}));fs.renameSync(ticketPath+'.tmp',ticketPath);
     }else if(line==='GODOT_Z_RELEASE_BATTLE={}'){
      assert.ok(held,'real declaration scheduled before release');const args=held;held=null;resolveBattle(...args);
     }else if(line.startsWith('GODOT_Z1715_CONNECTION_TESTS=')){
      assert.equal(proof,null);proof=JSON.parse(line.slice('GODOT_Z1715_CONNECTION_TESTS='.length));
     }
    }catch(error){adapterError=String(error.message);child.kill('SIGTERM');}
   }
   if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>8*1024*1024){adapterError='bounded_output_exceeded';child.kill('SIGTERM');}
  });
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const outcome=await new Promise((resolve,reject)=>{
   const deadline=setTimeout(()=>{adapterError='owned_runner_timeout';child.kill('SIGTERM');},70000);
   child.once('error',error=>{clearTimeout(deadline);reject(error);});
   child.once('close',(code,signal)=>{clearTimeout(deadline);closed=true;resolve({code,signal});});
  });
  assert.equal(adapterError,'');assert.equal(outcome.code,0);assert.equal(proof?.ok,true,proof?.error);
  assert.equal(/^(SCRIPT ERROR:|ERROR:)/mu.test(stdout+'\n'+stderr),false);
  assert.deepEqual(proof.reconnect_phases,['selected','battle_choice','resolving',null]);
  assert.deepEqual(ticketCounts,[3,3]);assert.equal(units.length,0);
  assert.deepEqual(match.record.players,initialDefinitions,'ordinary wheel definitions unchanged');
  for(const condition of nativeStatus.pokemon_conditions){
   assert.deepEqual([match.positions.get(condition.pokemon_index),match.waits.get(condition.pokemon_index),match.conditions.get(condition.pokemon_index)],
    [condition.index,condition.wait,condition.marker.circle]);
  }
  assert.deepEqual(match.zGauge,{black:100,white:0});
  const inputMoves=match.record.all_moves.filter(move=>move.value.type!=='add_z_gauge').map(({selective_side,value})=>({selective_side,value}));
  assert.deepEqual(inputMoves,nativeRecord.all_moves,'entire legal prefix actually submitted through Godot');
  assert.deepEqual(hashes(),before,'source stable during actual transport proof');
  t.diagnostic(JSON.stringify({assertions:proof.assertions,phases:proof.reconnect_phases,real_battle_clients:2,real_transport:'tcp',real_http:false,record_gauge_hydration:false,rendered_gpu:false,evidence}));
 }finally{
  if(child&&!closed){child.kill('SIGTERM');await new Promise(resolve=>{child.once('close',()=>{closed=true;resolve();});setTimeout(()=>{if(!closed)child.kill('SIGKILL');},2000).unref();});}
  if(match)match.phase='finished';await service.close();
  for(const secret of privateValues){assert.equal(stdout.includes(secret)||stderr.includes(secret),false,'private ticket/session leaked');}
  fs.writeFileSync(path.join(evidence,'stdout.txt'),stdout);fs.writeFileSync(path.join(evidence,'stderr.txt'),stderr);
  fs.writeFileSync(path.join(evidence,'verification.json'),JSON.stringify({before,after:hashes(),source_stable:JSON.stringify(before)===JSON.stringify(hashes()),proof,adapter_error:adapterError,owned_child_closed:closed,ticket_counts:ticketCounts,source_request_sha256:query.request_sha256,source_response_sha256:query.response_sha256,live_effects:false},null,2));
  const resolved=path.resolve(privateRoot);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('kiwi-core-tests-z1715-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 }
});


