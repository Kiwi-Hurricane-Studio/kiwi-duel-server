import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {hasMovementTransit,movementTransitContext,typedMovementTransitGrant,entryBlockadeMpBonus,canAbilityTransit} from './movement-transit.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/typed-arrow-contract.json',import.meta.url)));
const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url))).figures;
const expected={1385:[7,11],1386:[8,12],1387:[2,9],1405:[4,10],1406:[3,15],1424:[16,0],1445:[11,12],1474:[8,14]};
const states=['normal','burn','poison','bad_poison','paralyze','panic','sleep','freeze','melt','faint','curse'];
const side=p=>p<6?'black':'white',opponent=p=>p<6?6:0,edges=customMatchContract.fieldEdges;
const typeId=t=>Number(Object.entries(catalog).find(([id,r])=>r.playable&&Number(id)===r.rule_poke_id&&(r.type0===t||r.type1===t))[0]);
function fixture(owner,ability,allied=false){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('typed-arrow-private');
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.mp=2;f.skills=[{id:1199,color:1,speed_or_damage:50,range:96}];}}
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p),enemy=opponent(owner),through=allied?owner+1:enemy,route=owner===0?[15,11,6]:[11,15,20];
 figure(owner).id=contract.descriptions.find(r=>r.key==='ability:'+ability).figures[0]??1005;figure(owner).pokepower=ability;figure(through).id=typeId(expected[ability][0]);
 match.positions.set(owner,route[0]);match.positions.set(through,route[1]);match.turn=side(owner);match.record.first_player=side(owner);match.turns={black:1,white:1};
 return {service,match,figure,owner,enemy,through,route,context(){return movementTransitContext(match.record,match.positions,match.conditions,edges,match.waits)},move(route){return {selective_side:side(owner),value:{type:'mp_move',route}}}};
}
test('all eight original Arrow clauses, four real bindings and both entry pairs are independently enumerated',()=>{
 assert.deepEqual(contract.grants.map(r=>[r.ability,r.opposing_types]),Object.entries(expected).map(([id,types])=>[Number(id),types]));
 assert.deepEqual(contract.descriptions.map(r=>[Number(r.key.split(':')[1]),r.figures]),[[1385,[1527]],[1386,[1528]],[1387,[1529]],[1405,[]],[1406,[]],[1424,[]],[1445,[]],[1474,[1532]]]);
 for(const row of contract.descriptions){assert(row.evidence.some(e=>e.text===row.expected_behavior));assert.match(row.expected_behavior,/all (of )?your entry points/);assert.match(row.expected_behavior,/\+1 MP|MP \+1/);}
 assert.deepEqual(contract.entry_points,{black:[21,27],white:[0,6]});
});
for(const [id,types] of Object.entries(expected))for(const owner of [0,6]){
 const ability=Number(id);
 test(`${owner}: Arrow${ability} resolves every occupant alias and each original type independently`,()=>{
  const f=fixture(owner,ability);assert(hasMovementTransit(f.match.record,f.match.positions));
  for(const [id,row] of Object.entries(catalog)){
   f.figure(f.through).id=Number(id);const allowed=!!row.playable&&[row.type0,row.type1].some(t=>t!==null&&types.includes(t));
   assert.equal(!!typedMovementTransitGrant(f.context(),owner,f.through),allowed,'opponent '+id);
  }
  f.figure(f.through).id=900000099;f.figure(f.through).type0=types[0];assert.equal(typedMovementTransitGrant(f.context(),owner,f.through),null);
  for(const t of types){f.figure(f.through).id=typeId(t);assert(engine.validateMovement(f.match,side(owner),f.move(f.route)));}
  const a=fixture(owner,ability,true);for(const id of [1018,1005,900000099]){a.figure(a.through).id=id;assert(canAbilityTransit(a.context(),owner,a.through));}
  for(const condition of states){f.match.conditions.set(owner,condition);f.match.conditions.set(f.through,condition);assert(typedMovementTransitGrant(f.context(),owner,f.through));if(condition!=='faint')assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),!['sleep','freeze','melt'].includes(condition));}
  f.match.conditions.clear();f.match.waits.set(owner,1);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.waits.clear();
  for(const point of [-1,28+owner,40,41,42,43]){f.match.positions.set(owner,point);assert.equal(typedMovementTransitGrant(f.context(),owner,f.through),null);}
 });
 test(`${owner}: Arrow${ability} needs opponents on both own entries, with fresh bonus calculation`,()=>{
  const f=fixture(owner,ability);const entries=owner===0?[21,27]:[0,6];
  f.match.positions.set(f.through,28+f.through);
  for(const first of ['empty','allied','opposing'])for(const second of ['empty','allied','opposing']){
   for(const p of [owner+1,owner+2,f.enemy,f.enemy+1])f.match.positions.set(p,28+p);
   for(const [i,state] of [first,second].entries())if(state!=='empty')f.match.positions.set(state==='allied'?owner+1+i:f.enemy+i,entries[i]);
   assert.equal(entryBlockadeMpBonus(f.context(),owner),first==='opposing'&&second==='opposing'?1:0);
  }
  for(const condition of states){f.match.conditions.set(owner,condition);f.match.conditions.set(f.enemy,condition);f.match.conditions.set(f.enemy+1,condition);f.match.waits.set(f.enemy,7);assert.equal(entryBlockadeMpBonus(f.context(),owner),1);}
  for(const point of [28+owner,17,10]){f.match.positions.set(owner,point);assert.equal(entryBlockadeMpBonus(f.context(),owner),1);}
  for(const point of [-1,40,41,42,43]){f.match.positions.set(owner,point);assert.equal(entryBlockadeMpBonus(f.context(),owner),0);}
  f.match.positions.set(owner,28+owner);assert(hasMovementTransit(f.match.record,f.match.positions));assert(!engine.legalRoutes(f.match,side(owner),{allowedPokemon:owner}).length,'blocked bench entries are not an inferred traversal exception');
  f.match.positions.set(owner,owner===0?17:10);f.match.positions.set(f.enemy,28+f.enemy);assert.equal(entryBlockadeMpBonus(f.context(),owner),0);f.match.positions.set(f.enemy,entries[0]);assert.equal(entryBlockadeMpBonus(f.context(),owner),1);f.figure(owner).pokepower=-1;assert.equal(entryBlockadeMpBonus(f.context(),owner),0);
 });
 test(`${owner}: Arrow${ability} retains transit blockers, MP cost and source/end restrictions`,()=>{
  const f=fixture(owner,ability);for(const blocker of [1032,1051,1249,1300,1408,1446,1450,1244,1472]){f.figure(f.through).pokepower=blocker;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)),String(blocker));}f.figure(f.through).pokepower=-1;
  for(const [ability,condition] of [[1310,'poison'],[1310,'bad_poison'],[1331,'paralyze']]){f.figure(f.through).pokepower=ability;f.match.conditions.set(owner,condition);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));}f.figure(f.through).pokepower=-1;f.match.conditions.clear();
  for(const route of [f.route.slice(0,2),[...f.route,f.route[1]],[28+owner,owner===0?27:6]])assert(!engine.validateMovement(f.match,side(owner),f.move(route)));
  for(const mp of [0,1,2,3]){f.figure(owner).mp=mp;assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),mp>=2);}
 });
 test(`${owner}: Arrow${ability} bonus drives real authoritative three-edge moves and atomic rejection`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const f=fixture(owner,ability),errors=[],entries=owner===0?[21,27]:[0,6],route=owner===0?[17,18,19,14]:[10,9,8,13];
  f.match.positions.set(owner,route[0]);f.match.positions.set(f.enemy,entries[0]);f.match.positions.set(f.enemy+1,entries[1]);f.match.phase='started';f.match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};f.service.playOpponentTurn=()=>{};f.service.rejectPlayerMove=(_m,e)=>errors.push(e);t.after(()=>{f.match.phase='finished'});
  const send=value=>f.service.acceptPlayerMove(f.match,value,value.selective_side),snapshot=()=>JSON.stringify({record:f.match.record,positions:[...f.match.positions],conditions:[...f.match.conditions],waits:[...f.match.waits],ledger:f.match.completedTurnLedger});
  assert(engine.validateMovement(f.match,side(owner),f.move(route)));
  for(const invalid of [route.concat(owner===0?10:17),[route[0],entries[0]],[28+owner,entries[0]]]){const before=snapshot();send(f.move(invalid));assert.equal(errors.pop(),'illegal_player_movement');assert.equal(snapshot(),before);}
  f.match.positions.set(f.enemy,28+f.enemy);assert(!engine.validateMovement(f.match,side(owner),f.move(route)));f.match.positions.set(f.enemy,entries[0]);
  f.match.turns[side(owner)]=0;assert(!engine.validateMovement(f.match,side(owner),f.move(route)));assert(engine.validateMovement(f.match,side(owner),f.move(route.slice(0,3))));f.match.turns[side(owner)]=1;
  const before=[...f.match.positions];send(f.move(route));assert.deepEqual(errors,[]);assert.equal(f.match.positions.get(owner),route.at(-1));for(const [p,point] of before)if(p!==owner)assert.equal(f.match.positions.get(p),point);assert.equal(f.match.turn,side(f.enemy));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);assert.equal(new Set(f.match.positions.values()).size,12);
  const final=snapshot();send(f.move(route));assert.equal(errors.pop(),'stale_player_turn');assert.equal(snapshot(),final);
 });
}
test('Dark Arrow cannot bypass an opposing Dark team protected from Ghost traversal by Ghost Sensor',()=>{
 const f=fixture(0,1424);f.figure(0).id=typeId(15);f.figure(6).id=typeId(0);f.figure(7).pokepower=1287;f.match.positions.set(7,1);assert(typedMovementTransitGrant(f.context(),0,6));assert(!canAbilityTransit(f.context(),0,6));
});
