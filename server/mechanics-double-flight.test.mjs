import test from 'node:test';import assert from 'node:assert/strict';
import {CustomMatchService} from './custom-match-engine.mjs';
import {customMatchTestHooks} from './custom-match-engine.mjs';
const side=p=>p<6?'black':'white',enemy=p=>p<6?6:0,opposite=s=>s==='black'?'white':'black';
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
const snapshot=m=>JSON.stringify({record:m.record,turn:m.turn,points:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],battled:[...m.battledAfterField],ledger:m.completedTurnLedger,plates:m.plateState,z:m.zState});
function fixture(t,owner=0,defending=false){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0,spinUnitSource:()=>0}),match=service.createMatch('double-flight-isolated'),errors=[];
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);service.playOpponentTurn=()=>{};
 const opponent=enemy(owner),figure=p=>match.record.players.flatMap(row=>row.pokemons).find(f=>f.pokemon_index===p);
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.skills=[attack(1199,1,50)];}}
 figure(owner).id=1233;figure(owner).skills=[attack(1520,2,2,28),attack(1199,1,100,68)];match.positions.set(owner,13);match.positions.set(opponent,8);
 const attacker=defending?opponent:owner,defender=defending?owner:opponent,turn=side(attacker);match.turn=turn;
 const send=(value,selective=side(owner))=>service.acceptPlayerMove(match,{selective_side:selective,value},selective);
 const declare=(from=attacker,to=defender)=>{send({type:'declare_battle',from_pokemon:from,to_pokemon:to},side(from));assert.deepEqual(errors,[]);service.resolveBattle(match,match.activeBattleDeclaration.move,match.activeBattleDeclaration);
  // Condition wheel changes emit DisableSkill before scheduling the spin.
  // This fixture owns the timer; advance that real continuation explicitly.
  if(match.record.all_moves.at(-1)?.value.type==='disable_skill')service.performBattleSpin(match,from,to,side(from),match.activeBattleDeclaration);
 };
 t.after(()=>{match.phase='finished'});return {service,match,errors,owner,opponent,figure,send,declare,turn,attacker,defender};
}
for(const owner of [0,6])for(const defending of [false,true])for(const finish of ['decline','damage','double_flight'])test(`${owner}/${defending}/${finish}: Double Flight retains original turn and permits exactly one extra attack`,t=>{
 const f=fixture(t,owner,defending);f.match.waits.set(owner+1,4);f.declare();
 assert.equal(f.match.pendingJump.skill,1520);assert.deepEqual(f.match.pendingJump.targets,[0,9]);assert.equal(f.match.completedTurnLedger.completed_turns,0);
 f.send({type:'spot_move',from:13,to:0});assert.deepEqual(f.errors,[]);assert(f.match.pendingExtraBattle);assert.equal(f.match.turn,f.turn);assert.equal(f.service.selectionSide(f.match),side(owner));assert.equal(f.match.waits.get(owner+1),4);assert.equal(f.match.completedTurnLedger.completed_turns,0);
 const held=snapshot(f.match);for(const value of [{type:'spot_move',from:0,to:9},{type:'mp_move',route:[0,1]},{type:'declare_battle',from_pokemon:owner+1,to_pokemon:f.opponent},{type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent+1}]){f.send(value);assert.equal(f.errors.pop(),'illegal_double_flight_battle_choice');assert.equal(snapshot(f.match),held);}
 if(finish==='decline')f.send({type:'null_move'});
 else {
  const gauges={...f.match.zGauge};f.send({type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent});assert.deepEqual(f.errors,[]);
  assert.equal(f.match.completedTurnLedger.completed_turns,0);assert.equal(f.match.turn,f.turn);assert.equal(f.match.waits.get(owner+1),4);assert.deepEqual(f.match.zGauge,gauges,'native first-battle receipt remains deferred through extra declaration');assert(f.match.extraBattle.used);
  f.service.spinUnitSource=(_range,pokemon)=>finish==='damage'&&pokemon===owner?28:0;
  f.service.resolveBattle(f.match,f.match.activeBattleDeclaration.move,f.match.activeBattleDeclaration);
  if(finish==='double_flight'){
   assert(f.match.pendingJump);assert.deepEqual(f.match.pendingJump.targets,[9,13]);f.send({type:'spot_move',from:0,to:9});assert(!f.match.pendingExtraBattle);
  }else assert.equal(f.match.positions.get(f.opponent),f.opponent<6?41:43);
 }
 assert.deepEqual(f.errors,[]);assert.equal(f.match.turn,opposite(f.turn));assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.waits.get(owner+1),3);assert.equal(f.match.extraBattle,null);
 assert.equal(new Set(f.match.positions.values()).size,12);const final=snapshot(f.match);f.send({type:'spot_move',from:0,to:9});assert.equal(snapshot(f.match),final);
});
for(const owner of [0,6])for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'])test(`${owner}/${condition}: conditional knockout resolves at landing and is distinct from Wait`,t=>{
 const f=fixture(t,owner),wakes=condition==='sleep';f.match.conditions.set(f.opponent,condition);f.match.waits.set(f.opponent,4);f.declare();assert.deepEqual(f.match.pendingJump.conditionalKnockouts,wakes?[]:[f.opponent]);assert.equal(f.match.positions.get(f.opponent),8);assert.equal(f.match.conditions.get(f.opponent),wakes?'normal':condition==='freeze'?'melt':condition);
 f.send({type:'spot_move',from:13,to:0});assert.deepEqual(f.errors,[]);
 if(wakes){assert(f.match.pendingExtraBattle);assert.equal(f.match.completedTurnLedger.completed_turns,0);assert.equal(f.match.waits.get(f.opponent),4);f.send({type:'null_move'});assert.deepEqual(f.errors,[]);}
 assert.equal(f.match.positions.get(f.opponent),wakes?8:f.opponent<6?41:43);assert.equal(f.match.conditions.get(f.opponent),'normal');assert.equal(f.match.battledAfterField.get(f.opponent),wakes);assert.equal(f.match.waits.get(f.opponent),3);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: Wait alone cannot trigger Double Flight knockout`,t=>{
 const f=fixture(t,owner);f.match.waits.set(f.opponent,4);f.declare();assert.deepEqual(f.match.pendingJump.conditionalKnockouts,[]);f.send({type:'spot_move',from:13,to:0});assert(f.match.pendingExtraBattle);f.send({type:'null_move'});assert.equal(f.match.positions.get(f.opponent),8);assert.equal(f.match.waits.get(f.opponent),3);
});
for(const owner of [0,6])for(const ability of [1143,1381])test(`${owner}/${ability}: effect protection retains the opponent and extra battle choice`,t=>{
 const f=fixture(t,owner);f.figure(f.opponent).pokepower=ability;f.match.conditions.set(f.opponent,'poison');f.declare();assert.deepEqual(f.match.pendingJump.conditionalKnockouts,[]);assert(f.match.pendingJump.protectionSources.length);f.send({type:'spot_move',from:13,to:0});assert(f.match.pendingExtraBattle);f.send({type:'null_move'});assert.equal(f.match.positions.get(f.opponent),8);assert.equal(f.match.conditions.get(f.opponent),'poison');
});
for(const owner of [0,6])for(const conditioned of [false,true])test(`${owner}/${conditioned}: conditional knockout precedes the landing surround check`,t=>{
 const f=fixture(t,owner);f.match.positions.set(f.opponent+1,1);f.match.positions.set(f.opponent+2,7);if(conditioned)f.match.conditions.set(f.opponent,'poison');f.declare();f.send({type:'spot_move',from:13,to:0});assert.deepEqual(f.errors,[]);
 if(conditioned){assert.equal(f.match.positions.get(owner),0);assert(f.match.pendingExtraBattle);f.send({type:'null_move'});assert.equal(f.match.positions.get(f.opponent),f.opponent<6?41:43);}
 else {assert.equal(f.match.positions.get(owner),owner<6?41:43);assert(!f.match.pendingExtraBattle);}
 assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(new Set(f.match.positions.values()).size,12);
});
for(const owner of [0,6])test(`${owner}: blocked Center rejects the entire landing before any relocation`,t=>{
 const f=fixture(t,owner);f.match.conditions.set(f.opponent,'poison');f.declare();f.match.positions.set(f.opponent+1,41);f.match.positions.set(f.opponent+2,41);const before=snapshot(f.match);f.send({type:'spot_move',from:13,to:0});assert.equal(f.errors.pop(),'invalid_jump_knockout_disposition');assert.equal(snapshot(f.match),before);
});
for(const owner of [0,6])for(const plate of [5015,5022])for(const decline of [false,true])test(`${owner}/${plate}/${decline}: battle plate expires after first settlement and cannot affect extra battle`,t=>{
 const f=fixture(t,owner);f.match.record.players.find(p=>p.color===side(owner)).plates=[plate];
 f.send({type:'declare_plate',plate_id:plate,value:{type:'select_pokemon',pokemon:owner}});f.declare();
 if(plate===5015){assert(f.match.pendingRespin);assert(!f.match.pendingJump);f.send({type:'null_move'});}
 assert(f.match.pendingJump);f.send({type:'spot_move',from:13,to:0});assert(f.match.pendingExtraBattle);
 // Snapshot shape is a fixed Black/White pair; verify the consumed card itself.
 const active=customMatchTestHooks.plateStateSnapshot(f.match).plate_conditions[owner/6].plates.find(p=>p.id===plate);assert.equal(active.condition,'active');
 f.send(decline?{type:'null_move'}:{type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent});
 assert.equal(customMatchTestHooks.plateStateSnapshot(f.match).plate_conditions[owner/6].plates.find(p=>p.id===plate).condition,'used');
 if(!decline){f.service.spinUnitSource=(_range,p)=>p===owner?28:0;f.service.resolveBattle(f.match,f.match.activeBattleDeclaration.move,f.match.activeBattleDeclaration);assert(!f.match.pendingRespin);assert.equal(f.match.activeBattleResolution.phase,'completed');assert.equal(f.match.positions.get(f.opponent),f.opponent<6?41:43);}
 assert.deepEqual(f.errors,[]);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: Blackout Wait prevents the optional extra attack`,t=>{
 const f=fixture(t,owner);f.figure(f.opponent).pokepower=1326;f.declare();f.send({type:'spot_move',from:13,to:0});assert.deepEqual(f.errors,[]);assert(!f.match.pendingExtraBattle);assert.equal(f.match.conditions.get(owner),'paralyze');assert.equal(f.match.waits.get(owner),2);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: different figure's Double Flight after the extra battle retains an explicit chain-scope blocker`,t=>{
 const f=fixture(t,owner);f.figure(f.opponent).skills=[attack(1199,1,50,28),attack(1520,2,2,68)];f.declare();f.send({type:'spot_move',from:13,to:0});f.send({type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent});
 f.service.spinUnitSource=()=>28;f.service.resolveBattle(f.match,f.match.activeBattleDeclaration.move,f.match.activeBattleDeclaration);assert(f.match.pendingJump);assert.equal(f.match.pendingJump.pokemon,f.opponent);
 f.send({type:'spot_move',from:8,to:1},side(f.opponent));assert.deepEqual(f.errors,[]);assert.equal(f.match.pendingExtraBattle.unresolved_reason,'double_flight_other_figure_chain_scope_unverified');assert.equal(f.match.completedTurnLedger.completed_turns,0);
 const before=snapshot(f.match);f.send({type:'null_move'},side(f.opponent));assert.equal(f.errors.pop(),'illegal_double_flight_battle_choice');assert.equal(snapshot(f.match),before);
});
for(const owner of [0,6])for(const defending of [false,true])test(`${owner}/${defending}: winning Double Flight suppresses White Ice Shard before its extra choice`,t=>{
 const f=fixture(t,owner,defending);f.figure(f.opponent).skills=[attack(1001,1,50)];f.declare();assert.equal(f.match.pendingJump.unresolved_reason,undefined);assert.deepEqual(f.match.pendingJump.targets,[0,9]);assert.deepEqual(f.match.pendingJump.outcome.secondarySpins,[]);assert.equal(f.match.completedTurnLedger.completed_turns,0);
 f.send({type:'spot_move',from:13,to:0});assert.deepEqual(f.errors,[]);assert(f.match.pendingExtraBattle);assert.equal(f.match.completedTurnLedger.completed_turns,0);
 f.send({type:'null_move'});assert.deepEqual(f.errors,[]);assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.pendingSecondarySpins,null);
});
for(const owner of [0,6])for(const [id,color,power] of [[1199,3,50],[1122,4,0],[1009,2,2],[1009,2,3]])test(`${owner}/${color}/${power}: losing or tied Double Flight has no landing or extra attack`,t=>{
 const f=fixture(t,owner);f.figure(f.opponent).skills=[attack(id,color,power)];f.declare();assert(!f.match.pendingJump);assert(!f.match.pendingExtraBattle);assert.equal(f.match.completedTurnLedger.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: different second winner with Wait ends the turn without admitting a new chain`,t=>{
 const f=fixture(t,owner);f.figure(owner).pokepower=1326;f.figure(f.opponent).skills=[attack(1199,1,50,28),attack(1520,2,2,68)];f.declare();f.send({type:'spot_move',from:13,to:0});assert.equal(f.match.waits.get(f.opponent),3);
 f.send({type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent});f.service.spinUnitSource=()=>28;f.service.resolveBattle(f.match,f.match.activeBattleDeclaration.move,f.match.activeBattleDeclaration);
 assert.equal(f.match.record.all_moves.at(-1).value.type,'disable_skill');f.service.performBattleSpin(f.match,owner,f.opponent,side(owner),f.match.activeBattleDeclaration);assert(f.match.pendingJump);
 f.send({type:'spot_move',from:8,to:1},side(f.opponent));assert.deepEqual(f.errors,[]);assert(!f.match.pendingExtraBattle);assert.equal(f.match.completedTurnLedger.completed_turns,1);assert.equal(f.match.waits.get(f.opponent),2);
});
