import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService, customMatchContract} from './custom-match-engine.mjs';
import {purpleJumpPlan} from './purple-jump.mjs';
import {purpleFlyNetworkCases} from '../tests/purple-fly-network-cases.mjs';
const inventory=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const variants=inventory.entries.find(e=>e.key==='skill:1057').variants;
const side=p=>p<6?'black':'white', other=s=>s==='black'?'white':'black';
const state=m=>JSON.stringify({record:m.record,points:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],battled:[...m.battledAfterField],turn:m.turn,ledger:m.completedTurnLedger,z:m.zState,plates:m.plateState});
function fixture(t,owner=0,defending=false,variant=variants[0]) {
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0}),match=service.createMatch('fly-isolated'),errors=[];
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};
 service.rejectPlayerMove=(_m,reason)=>errors.push(reason);service.playOpponentTurn=()=>{};
 const enemy=owner===0?6:0,figure=p=>match.record.players.flatMap(r=>r.pokemons).find(f=>f.pokemon_index===p);
 for(const player of match.record.players)for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.skills=[{id:1199,color:1,range:96,speed_or_damage:50}];}
 figure(owner).id=variant.occurrences[0].figure_id;figure(owner).skills=[{id:1057,color:2,range:variant.range,speed_or_damage:variant.stars},{id:1131,color:0,range:96-variant.range,speed_or_damage:0}];
 match.positions.set(owner,12);match.positions.set(enemy,16);
 const attacker=defending?enemy:owner,defender=defending?owner:enemy;match.turn=side(attacker);
 const send=(value,who=side(owner))=>service.acceptPlayerMove(match,{selective_side:who,value},who);
 const spin=()=>{send({type:'declare_battle',from_pokemon:attacker,to_pokemon:defender},side(attacker));assert.deepEqual(errors,[]);service.performBattleSpin(match,attacker,defender,side(attacker));};
 t.after(()=>{match.phase='finished'});return {service,match,owner,enemy,figure,errors,send,spin,attacker,defender};
}
test('Fly inventory retains all six original Purple variants',()=>{assert.equal(variants.length,6);assert(variants.every(v=>v.color===2&&v.stars===3));});
for(const owner of [0,6])for(const defending of [false,true])for(const [v,variant] of variants.entries())test(`${owner}/${defending}/${v}: actual Fly choice holds battle then completes once`,t=>{
 const f=fixture(t,owner,defending,variant);f.match.waits.set(owner+1,4);f.spin();
 assert.equal(f.match.turn,side(f.attacker));assert.equal(f.service.selectionSide(f.match),side(owner));assert.deepEqual(f.match.pendingJump.targets,[21,17,22]);
 assert.equal(f.match.completedTurnLedger.completed_turns,0);assert.equal(f.match.waits.get(owner+1),4);assert.equal(f.match.battledAfterField.get(owner),false);
 const before=state(f.match);for(const value of [{type:'null_move'},{type:'spot_move',from:12,to:16},{type:'spot_move',from:16,to:21},{type:'spot_move',from:12,to:21,pokemon:owner}]){f.send(value);assert.equal(f.errors.pop(),'illegal_purple_jump_choice');assert.equal(state(f.match),before);}
 f.send({type:'spot_move',from:12,to:21},other(side(owner)));assert.equal(f.errors.pop(),'stale_player_turn');assert.equal(state(f.match),before);
 f.send({type:'spot_move',from:12,to:21});assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),21);assert.equal(f.match.turn,other(side(f.attacker)));assert.equal(f.match.waits.get(owner+1),3);
 assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.pendingJump,null);assert.equal(f.match.battledAfterField.get(owner),true);assert.equal(f.match.battledAfterField.get(f.enemy),true);
 const completed=state(f.match);f.send({type:'spot_move',from:12,to:21});assert.equal(f.errors.pop(),defending?'illegal_player_spot_move':'stale_player_turn');assert.equal(state(f.match),completed);
});
for(const owner of [0,6])for(const defending of [false,true])test(`${owner}/${defending}: surrounding self after Fly uses Center and one completed battle`,t=>{
 const f=fixture(t,owner,defending);f.match.positions.set(f.enemy+1,17);f.match.positions.set(f.enemy+2,22);f.spin();assert.deepEqual(f.match.pendingJump.targets,[21]);
 f.send({type:'spot_move',from:12,to:21});assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),owner===0?41:43);assert.equal(f.match.conditions.get(owner),'normal');assert.equal(f.match.battledAfterField.get(owner),false);assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(new Set(f.match.positions.values()).size,12);
});
for(const owner of [0,6])test(`${owner}: post-Fly surrounding honors immunity and rejects unknown replacement atomically`,t=>{
 for(const power of [1122,1054]){const f=fixture(t,owner);f.match.positions.set(owner+1,23);f.match.positions.set(f.enemy+1,22);f.figure(f.enemy+1).pokepower=power;f.spin();const before=state(f.match);f.send({type:'spot_move',from:12,to:21});
  if(power===1054){assert.equal(state(f.match),before);assert.match(f.errors.pop(),/surround/);}else{assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(f.enemy+1),22);}
 }
});
for(const owner of [0,6])test(`${owner}: an empty Fly landing set cannot silently complete the battle`,t=>{
 const f=fixture(t,owner);f.match.positions.set(owner+1,21);f.match.positions.set(owner+2,17);f.match.positions.set(owner+3,22);f.spin();assert.deepEqual(f.match.pendingJump.targets,[]);assert.equal(f.match.completedTurnLedger.completed_turns,0);assert.equal(f.match.battledAfterField.get(owner),false);
 const before=state(f.match);f.send({type:'null_move'});assert.equal(f.errors.pop(),'illegal_purple_jump_choice');assert.equal(state(f.match),before);
});
for(const owner of [0,6])test(`${owner}: occupied Fly intermediate space retains empty second-step landings`,t=>{
 const f=fixture(t,owner);f.match.positions.set(owner+1,21);f.spin();assert.deepEqual(f.match.pendingJump.targets,[17,22]);
 f.send({type:'spot_move',from:12,to:17});assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),17);assert.equal(f.match.positions.get(owner+1),21);assert.equal(new Set(f.match.positions.values()).size,12);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: Fly loses to Gold, Blue and stronger/tied Purple without a landing choice`,t=>{
 for(const [id,color,power]of [[1199,3,50],[1122,4,0],[1009,2,3],[1009,2,4]]){const f=fixture(t,owner);f.figure(f.enemy).skills=[{id,color,range:96,speed_or_damage:power}];f.spin();assert(!f.match.pendingJump);assert.equal(f.match.completedTurnLedger.completed_turns,1);}
});
for(const owner of [0,6])for(const mode of ['decline','respin'])test(`${owner}: Double Chance ${mode} defers or replaces the entire Fly choice`,t=>{
 const f=fixture(t,owner);f.match.record.players.find(p=>p.color===side(owner)).plates=[5015];
 f.send({type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}});assert.deepEqual(f.errors,[]);f.spin();
 assert(f.match.pendingRespin);assert(!f.match.pendingJump);assert.equal(f.match.positions.get(owner),12);assert.equal(f.match.completedTurnLedger.completed_turns,0);
 if(mode==='decline'){
  f.send({type:'null_move'});assert(f.match.pendingJump);assert.equal(f.match.completedTurnLedger.completed_turns,0);f.send({type:'spot_move',from:12,to:21});assert.equal(f.match.positions.get(owner),21);
 } else {
  f.send({type:'declare_respin',pokemons:[owner]});f.service.spinUnitSource=()=>48;f.service.performPendingRespin(f.match);assert(!f.match.pendingJump);assert.equal(f.match.positions.get(owner),owner===0?41:43);
 }
 assert.deepEqual(f.errors,[]);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
const nativeCases=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases;
for(const owner of [0,6])for(const defending of [false,true])test(`${owner}/${defending}: winning Fly suppresses White Ice Shard and permits its landing`,t=>{
 const f=fixture(t,owner,defending);f.figure(f.enemy).skills=[{id:1001,color:1,range:96,speed_or_damage:50}];f.spin();
 assert.equal(f.match.pendingJump.unresolved_reason,undefined);assert.deepEqual(f.match.pendingJump.targets,[21,17,22]);assert.deepEqual(f.match.pendingJump.outcome.secondarySpins,[]);
 assert.equal(f.match.positions.get(owner),12);assert.equal(f.match.completedTurnLedger.completed_turns,0);assert.equal(f.match.battledAfterField.get(owner),false);
 f.send({type:'spot_move',from:12,to:21});assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),21);assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.pendingSecondarySpins,null);
 const before=state(f.match);f.send({type:'spot_move',from:12,to:21});assert.equal(f.errors.pop(),defending?'illegal_player_spot_move':'stale_player_turn');assert.equal(state(f.match),before);
});
for(const scenario of purpleFlyNetworkCases(nativeCases))test(`full legal Fly route ${scenario.name}`,t=>{
 const f=fixture(t);f.match.positions=new Map(Array.from({length:12},(_,p)=>[p,28+p]));f.match.turn='black';f.match.record.players=structuredClone(scenario.record.players);
 for(const action of scenario.actions){const before=state(f.match);f.send(action.value,action.selective_side);if(action.expected_rejection){assert.equal(f.errors.pop(),action.expected_rejection);assert.equal(state(f.match),before);continue;}assert.deepEqual(f.errors,[]);
  if(action.value.type==='declare_battle')f.service.performBattleSpin(f.match,action.value.from_pokemon,action.value.to_pokemon,action.selective_side);
 }
 assert.equal(f.match.turn,scenario.final_turn);assert.deepEqual(Object.fromEntries(f.match.positions),scenario.expected_positions);assert.deepEqual(Object.fromEntries(f.match.battledAfterField),scenario.expected_battled);
});
