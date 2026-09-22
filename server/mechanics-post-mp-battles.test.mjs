import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {postMpBattlePolicy,restrictPostMpBattles,latestMpMover} from './post-mp-battles.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const side=p=>p<6?'black':'white',enemy=p=>p<6?6:0;
const graph=new Map();for(const [a,b] of customMatchContract.fieldEdges){if(!graph.has(a))graph.set(a,[]);if(!graph.has(b))graph.set(b,[]);graph.get(a).push(b);graph.get(b).push(a);}
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/post-mp-battle-contract.json',import.meta.url)));
function fixture(t,owner,ability=-1,binding=null){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('post-mp-battles-isolated'),errors=[];
 service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};match.turn=side(owner);match.turns={black:1,white:1};
 const figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p),opponent=enemy(owner),source=ability===1050?owner:opponent,route=owner===0?[10,6]:[17,21];
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.mp=2;f.skills=[{id:1122,color:4,speed_or_damage:0,range:96}];}}
 figure(source).pokepower=ability;figure(source).id=binding??contract.descriptions.find(e=>e.key==='ability:'+ability)?.figures[0]??1005;
 match.positions.set(owner,route[0]);match.positions.set(opponent,owner===0?5:22);match.positions.set(opponent+1,owner===0?11:16);
 t.after(()=>{match.phase='finished'});
 const send=value=>{const move={selective_side:side(owner),value};service.acceptPlayerMove(match,move,side(owner));return move;};
 return {service,match,owner,opponent,source,route,figure,errors,send,move(){return send({type:'mp_move',route})}};
}
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],waits:[...m.waits],conditions:[...m.conditions],turn:m.turn,ledger:m.completedTurnLedger,pending:m.pendingBattles,plate:m.plateState});
test('default wheel and tied-condition RNG keep the Pokémon context separate from the upper bound',t=>{
 const f=fixture(t,0);
 for(let pokemon=0;pokemon<12;pokemon++){
  for(const range of [1,2,96]){const unit=f.service.spinUnitSource(range,pokemon);assert(Number.isInteger(unit)&&unit>=0&&unit<range);}
  f.figure(pokemon).skills=[{id:1199,color:1,range:48,speed_or_damage:50},{id:1003,color:3,range:48,speed_or_damage:50}];
  for(const condition of ['paralyze','burn']){f.match.conditions.set(pokemon,condition);for(const source of [undefined,f.service.conditionChoiceSource]){const chosen=engine.conditionDisabledSkills(f.match,pokemon,source);assert.equal(chosen.length,1);assert([1199,1003].includes(chosen[0]));}}
  f.match.conditions.set(pokemon,'paralyze');assert([1199,1003].includes(engine.paralysisDisabledSkill(f.match,pokemon)));
 }
});
test('four post-MP battle clauses preserve every original description and binding',()=>{
 const originals=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures,texts=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
 for(const row of contract.descriptions){const ability=Number(row.key.split(':')[1]);assert.deepEqual(Object.entries(originals).filter(([,f])=>f.pokepower_id===ability).map(([id])=>Number(id)).sort((a,b)=>a-b),row.figures);for(const proof of row.evidence)assert.equal(texts.find(t=>t.text_key===proof.key).text,proof.text);}
});
for(const owner of [0,6])for(const ability of [1032,1050,1464])test(`${owner}: ${ability} actual MP closes without attack, holds positions and completes once`,t=>{
 const f=fixture(t,owner,ability),before=[...f.match.positions];f.match.waits.set(owner+1,3);f.move();assert.deepEqual(f.errors,[]);
 assert.equal(f.match.turn,side(f.opponent));assert.deepEqual(f.match.pendingBattles,[]);assert.equal(f.match.waits.get(owner+1),2);assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);
 for(const [p,point] of before)assert.equal(f.match.positions.get(p),p===owner?f.route.at(-1):point);
 assert(!f.match.record.all_moves.some(m=>['spin','declare_battle','pokepower_notice'].includes(m.value.type)));
 for(const value of [{type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent},{type:'null_move'},{type:'mp_move',route:f.route}]){const old=snapshot(f.match);f.send(value);assert.equal(f.errors.pop(),'stale_player_turn');assert.equal(snapshot(f.match),old);}
 // The opponent may attack this figure, and a later direct attack by the
 // original mover is permitted. The MP ban must not become a lasting marker.
 const incoming={selective_side:side(f.opponent),value:{type:'declare_battle',from_pokemon:f.opponent,to_pokemon:owner}};
 assert(engine.validateBattleDeclaration(f.match,side(f.opponent),incoming));f.service.acceptPlayerMove(f.match,incoming,side(f.opponent));f.service.resolveBattle(f.match,incoming);
 assert.equal(f.match.turn,side(owner));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,2);
 const later={selective_side:side(owner),value:{type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent}};assert(engine.validateBattleDeclaration(f.match,side(owner),later));
});
for(const owner of [0,6])for(const binding of [1184,1602])test(`${owner}: Territoriality ${binding} requires its battle and rejects every escape before mutation`,t=>{
 const f=fixture(t,owner,1051,binding);f.move();assert.deepEqual(f.errors,[]);assert.equal(f.match.turn,side(owner));assert.deepEqual(f.match.pendingBattles.map(m=>m.value.to_pokemon),[f.opponent]);assert(engine.pendingMpBattleMandatory(f.match,side(owner)));
 const rejects=[[{type:'null_move'},'battle_required_after_mp'],[{type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent+1},'illegal_player_battle'],[{type:'mp_move',route:[28+owner+1,owner===0?27:0]},'battle_continuation_required'],[{type:'declare_plate',plate_id:5022,value:{type:'select_pokemon',pokemon:owner}},'battle_continuation_required'],[{type:'declare_turn_end'},'battle_continuation_required']];
 for(const [value,error] of rejects){const old=snapshot(f.match);f.send(value);assert.equal(f.errors.pop(),error);assert.equal(snapshot(f.match),old);}
 const move=f.send({type:'declare_battle',from_pokemon:owner,to_pokemon:f.opponent});assert.deepEqual(f.errors,[]);f.service.resolveBattle(f.match,move);assert.equal(f.match.turn,side(f.opponent));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);assert(f.match.record.all_moves.some(m=>m.value.type==='spin'));
});
for(const owner of [0,6])for(const ability of [1032,1464,1051])test(`${owner}: ${ability} field, side, adjacency and source-condition scope`,t=>{
 const f=fixture(t,owner,ability);f.match.positions.set(owner,f.route.at(-1));const choices=engine.pendingBattlesAfterMovement(f.match,side(owner),owner,f.route.at(-1),-1);
 for(const condition of ['normal','burn','poison','bad_poison','paralyze','panic','sleep','freeze','melt']){f.match.conditions.set(f.source,condition);const p=restrictPostMpBattles(f.match.record,f.match.positions,owner,graph,choices);assert.equal(p.choices.length,ability===1051?1:0);assert.equal(p.mandatory,ability===1051);}
 for(const point of [-1,28+f.source,40,41,42,43,owner===0?0:27]){f.match.positions.set(f.source,point);assert.deepEqual(postMpBattlePolicy(f.match.record,f.match.positions,owner,graph),{blocked:[],required:[]});}
 f.figure(f.source).pokepower=-1;f.figure(owner+1).pokepower=ability;f.match.positions.set(owner+1,owner===0?5:22);assert.deepEqual(postMpBattlePolicy(f.match.record,f.match.positions,owner,graph),{blocked:[],required:[]});
});
for(const owner of [0,6])test(`${owner}: multiple required targets remain choices, and a ban makes the battle impossible`,t=>{
 const f=fixture(t,owner,1051);f.figure(f.opponent+1).pokepower=1051;f.match.positions.set(owner,f.route.at(-1));const choices=engine.pendingBattlesAfterMovement(f.match,side(owner),owner,f.route.at(-1),-1);
 const policy=restrictPostMpBattles(f.match.record,f.match.positions,owner,graph,choices);assert.deepEqual(policy.choices.map(c=>c.value.to_pokemon),[f.opponent,f.opponent+1]);assert(policy.mandatory);
 assert.equal(restrictPostMpBattles(f.match.record,f.match.positions,owner,graph,[]).mandatory,false);
 for(const ability of [1032,1464]){f.figure(f.opponent+1).pokepower=ability;const p=restrictPostMpBattles(f.match.record,f.match.positions,owner,graph,choices);assert.deepEqual(p.choices,[]);assert(!p.mandatory);}
 f.figure(f.opponent+1).pokepower=1051;f.figure(owner).pokepower=1050;assert.deepEqual(restrictPostMpBattles(f.match.record,f.match.positions,owner,graph,choices).choices,[]);
});
for(const owner of [0,6])test(`${owner}: ordinary optional battle cannot be bypassed with a second movement, plate or plate skip`,t=>{
 const f=fixture(t,owner);f.move();assert.equal(f.match.pendingBattles.length,2);assert(!engine.pendingMpBattleMandatory(f.match,side(owner)));
 for(const value of [{type:'mp_move',route:[28+owner+1,owner===0?27:0]},{type:'declare_plate',plate_id:5022,value:{type:'select_pokemon',pokemon:owner}},{type:'declare_turn_end'}]){const old=snapshot(f.match);f.send(value);assert.equal(f.errors.pop(),'battle_continuation_required');assert.equal(snapshot(f.match),old);}
 f.send({type:'null_move'});assert.deepEqual(f.errors,[]);assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);
});
for(const owner of [0,6])test(`${owner}: explicit MP context cannot leak onto jump/plate/direct continuations`,t=>{
 const f=fixture(t,owner,1050);f.match.positions.set(owner,f.route.at(-1));assert.equal(engine.pendingBattlesAfterMovement(f.match,side(owner),owner,f.route.at(-1),-1,false).length,2);assert.equal(engine.pendingBattlesAfterMovement(f.match,side(owner),owner,f.route.at(-1),-1,true).length,0);
 f.match.record.all_moves=[{selective_side:side(owner),value:{type:'mp_move',route:f.route}},{selective_side:'neither',value:{type:'remove_debuff',pokemons:[owner]}},{selective_side:'both',value:{type:'add_z_gauge',pokemon:owner,value:1}}];assert.equal(latestMpMover(f.match.record,f.match.positions,side(owner)),owner);assert.equal(latestMpMover(f.match.record,f.match.positions,side(f.opponent)),-1);
 for(const type of ['null_move','declare_battle','declare_plate','spot_move','route_move','z_skill']){const r=structuredClone(f.match.record);r.all_moves.push({selective_side:side(owner),value:{type}});assert.equal(latestMpMover(r,f.match.positions,side(owner)),-1);}
});
