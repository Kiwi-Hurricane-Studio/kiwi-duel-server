import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {hasMovementTransit,movementTransitContext,movementTransitGrant,movementTransitBlockers,canAbilityTransit,movementMpBlockers,unverifiedTransitRouteBlockers} from './movement-transit.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const rules=JSON.parse(readFileSync(new URL('../data/movement_transit_rules.json',import.meta.url))),contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/movement-transit-contract.json',import.meta.url))),catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url))).figures,edges=customMatchContract.fieldEdges;
const side=p=>p<6?'black':'white',opposite=p=>p<6?6:0,adjacent=p=>edges.flatMap(([a,b])=>a===p?[b]:b===p?[a]:[]);
function fixture(t,owner=0,ability=1248,allied=false){
 if(t)t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('movement-transit-isolated'),errors=[];service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,reason)=>errors.push(reason);
 match.phase='started';match.socket={destroyed:false,write(){},destroy(error){errors.push(error?.message)}};match.turn=side(owner);match.turns={black:1,white:1};
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[{id:1199,color:1,speed_or_damage:50,range:96}];}}
 if(t)t.after(()=>{match.phase='finished'});
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p),enemy=opposite(owner),through=allied?owner+1:enemy,route=owner===0?[15,11,6]:[11,15,20];
 figure(owner).pokepower=ability;figure(owner).id=contract.descriptions.find(d=>d.key==='ability:'+ability)?.figures[0]??1005;match.positions.set(owner,route[0]);match.positions.set(through,route[1]);
 return {service,match,owner,enemy,through,route,errors,figure,send(move){service.acceptPlayerMove(match,move,move.selective_side)},context(){return movementTransitContext(match.record,match.positions,match.conditions,edges)},move(route){return {selective_side:side(owner),value:{type:'mp_move',route}}}};
}
const snapshot=m=>JSON.stringify({record:m.record,positions:[...m.positions],conditions:[...m.conditions],waits:[...m.waits],turn:m.turn,ledger:m.completedTurnLedger,pending:m.pendingBattles});
test('inactive fast path skips only positions with no field grant or adjacent MP blocker',()=>{
 const f=fixture(null);assert(hasMovementTransit(f.match.record,f.match.positions));f.figure(0).pokepower=-1;assert(!hasMovementTransit(f.match.record,f.match.positions));f.figure(1).pokepower=1248;assert(!hasMovementTransit(f.match.record,f.match.positions));f.figure(6).pokepower=1244;assert(hasMovementTransit(f.match.record,f.match.positions));assert.equal(engine.legalRoutes(f.match,'black').filter(m=>m.value.route[0]===15).length,0);
});
test('every enrolled transit clause has exact original bindings and descriptions',()=>{
 const figures=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures,texts=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
 assert.equal(rules.self_field_grants.length,24);for(const row of contract.descriptions){const id=Number(row.key.split(':')[1]);assert.deepEqual(Object.entries(figures).filter(([,f])=>f.pokepower_id===id).map(([id])=>Number(id)).sort((a,b)=>a-b),row.figures);assert.equal(texts.find(t=>t.text_key==='FigureMaster.PokepowerDescription.'+id).text,row.evidence.text);}
 for(const type of contract.types)assert(texts.some(t=>t.text_key==='FigureMaster.TypeName.'+type.id&&t.text===type.name));
});
for(const ability of rules.self_field_grants)for(const owner of [0,6])for(const allied of [false,true])test(`${owner}: ${ability} actual ${allied?'allied':'opposing'} intermediate traversal retains occupants, actions and turn ledger`,t=>{
 const f=fixture(t,owner,ability,allied),before=[...f.match.positions];assert(canAbilityTransit(f.context(),owner,f.through));assert(engine.validateMovement(f.match,side(owner),f.move(f.route)));
 for(const invalid of [f.route.slice(0,2),[...f.route,f.route[1]],f.route.concat(f.route[0])]){const state=snapshot(f.match);assert(!engine.validateMovement(f.match,side(owner),f.move(invalid)));f.send(f.move(invalid));assert.equal(snapshot(f.match),state);assert.equal(f.errors.pop(),'illegal_player_movement');}
 f.send(f.move(f.route));assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),f.route.at(-1));for(const [p,point] of before)if(p!==owner)assert.equal(f.match.positions.get(p),point);assert.equal(new Set(f.match.positions.values()).size,12);
 assert(f.match.record.all_moves.some(m=>m.value.type==='mp_move'&&JSON.stringify(m.value.route)===JSON.stringify(f.route)));assert(!f.match.record.all_moves.some(m=>m.value.type==='spin'));
 if(!allied){assert.equal(f.match.turn,side(owner));assert(f.match.pendingBattles.some(m=>m.value.to_pokemon===f.through));f.send({selective_side:side(owner),value:{type:'null_move'}});}
 assert.equal(f.match.turn,side(f.enemy));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);const after=snapshot(f.match);f.send(f.move(f.route));assert.equal(f.errors.pop(),'stale_player_turn');assert.equal(snapshot(f.match),after);
});
for(const ability of rules.self_field_grants)for(const owner of [0,6])test(`${owner}: ${ability} honors MP/first turn/Wait and existing movement conditions; generic bench traversal remains unverified`,t=>{
 const f=fixture(t,owner,ability);for(const mp of [0,1,2,3]){f.figure(owner).mp=mp;assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),mp>=2);}
 f.figure(owner).mp=2;f.match.record.first_player=side(owner);f.match.turns[side(owner)]=0;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));assert(engine.legalRoutes(f.match,side(owner),{ignoreFirstTurnPenalty:true}).some(m=>JSON.stringify(m.value.route)===JSON.stringify(f.route)));f.match.turns[side(owner)]=1;
 for(const condition of ['normal','burn','poison','bad_poison','paralyze','panic','sleep','freeze','melt']){f.match.conditions.set(owner,condition);assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),!['sleep','freeze','melt'].includes(condition),condition);}
 f.match.conditions.set(owner,'normal');f.match.waits.set(owner,1);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.waits.set(owner,0);
 for(const point of [-1,28+owner,40,41,42,43]){f.match.positions.set(owner,point);assert.equal(movementTransitGrant(f.context(),owner),null);}
});
for(const owner of [0,6])test(`${owner}: selected figure constraints, missing records, malformed/multiple occupancy and unregistered abilities cannot fabricate transit`,t=>{
 const f=fixture(t,owner);assert.deepEqual(engine.legalRoutes(f.match,side(owner),{allowedPokemon:owner+1}).filter(m=>m.value.route[0]===f.route[0]),[]);
 for(const ability of [-1,999999,1245,1272,1375,1457,1465,1473]){f.figure(owner).pokepower=ability;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)),'unhandled mandatory transit/goal clause stays unenrolled: '+ability);}
 f.figure(owner).pokepower=1248;f.match.positions.set(f.enemy+1,f.route[1]);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.positions.set(f.enemy+1,28+f.enemy+1);
 const context=f.context();for(const p of [-1,12,NaN,0.5])assert.equal(movementTransitGrant(context,p),null);assert.equal(canAbilityTransit(context,owner,owner),false);assert.equal(canAbilityTransit(context,owner,12),false);context.figures.delete(f.through);assert.equal(canAbilityTransit(context,owner,f.through),false);
});
for(const blocker of [1032,1051,1249,1408])for(const owner of [0,6])test(`${owner}: ${blocker} prohibits opposing traversal through holder, but not allied traversal`,t=>{
 for(const allied of [false,true]){const f=fixture(t,owner,1248,allied);f.figure(f.through).pokepower=blocker;assert.equal(canAbilityTransit(f.context(),owner,f.through),allied);assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),allied);if(!allied){const before=snapshot(f.match);f.send(f.move(f.route));assert.equal(f.errors.pop(),'illegal_player_movement');assert.equal(snapshot(f.match),before);}}
});
for(const blocker of [1287,1310,1331,1446,1450])for(const owner of [0,6])test(`${owner}: ${blocker} checks every original mover type alias, ignores overrides, and preserves scope`,t=>{
 const f=fixture(t,owner),source=[1310,1450].includes(blocker)?f.through:f.enemy+1;f.figure(source).pokepower=blocker;f.figure(f.through).id=1177;if(source!==f.through)f.match.positions.set(source,0);
 for(const [id,row] of Object.entries(catalog)){f.figure(owner).id=Number(id);f.figure(owner).type=15;const types=row.playable?[row.type0,row.type1]:[],blocked=blocker===1287?types.includes(15):blocker===1310?types.some(t=>[2,17].includes(t)):blocker===1331?types.includes(1):!types.some(t=>[11,15].includes(t));assert.equal(movementTransitBlockers(f.context(),owner,f.through).length>0,blocked,id);}
 f.figure(owner).id=1106;if(blocker===1287){f.figure(f.through).id=1005;assert(canAbilityTransit(f.context(),owner,f.through));}
 for(const point of [-1,28+source,40,41,42,43]){f.match.positions.set(source,point);assert.equal(movementTransitBlockers(f.context(),owner,f.through).length,0);}
});
for(const owner of [0,6])test(`${owner}: Poisonous Bunker suppresses both poisoned teams, Electrobind only opposing Electric/paralyzed movers`,t=>{
 for(const ability of [1310,1331])for(const alliedSource of [false,true]){
  const f=fixture(t,owner),source=alliedSource?owner+1:f.enemy+1;f.figure(source).pokepower=ability;f.match.positions.set(source,0);f.figure(owner).id=1005;
  for(const condition of ['normal','poison','bad_poison','burn','paralyze','panic','sleep','freeze','melt','faint','curse']){f.match.conditions.set(owner,condition);const blocked=ability===1310?['poison','bad_poison'].includes(condition):!alliedSource&&condition==='paralyze';assert.equal(canAbilityTransit(f.context(),owner,f.through),!blocked,`${ability}/${alliedSource}/${condition}`);}
  f.figure(owner).id=1018;f.match.conditions.set(owner,'paralyze');assert.equal(movementTransitBlockers(f.context(),owner,f.through).length,ability===1331&&!alliedSource?1:0,'Electric plus paralysis does not duplicate source');
 }
});
for(const owner of [0,6])test(`${owner}: Invisible Wall follows an entire connected allied component and ends when a link leaves`,t=>{
 const f=fixture(t,owner),source=f.enemy+1,link=f.enemy+2;f.match.positions.set(owner,10);f.match.positions.set(f.through,6);f.match.positions.set(source,4);f.match.positions.set(link,5);f.figure(source).pokepower=1300;const route=[10,6,11];assert(!canAbilityTransit(f.context(),owner,f.through));assert(!engine.validateMovement(f.match,side(owner),f.move(route)));
 for(const condition of ['normal','sleep','freeze','melt','poison']){f.match.conditions.set(link,condition);assert(!canAbilityTransit(f.context(),owner,f.through),'wall text has no condition gate');}
 f.match.positions.set(link,28+link);assert(canAbilityTransit(f.context(),owner,f.through));assert(engine.validateMovement(f.match,side(owner),f.move(route)));f.match.positions.set(owner+1,5);assert(canAbilityTransit(f.context(),owner,f.through),'opposing link cannot join holder wall');
 f.match.positions.set(owner+1,28+owner+1);f.match.positions.set(link,5);f.match.positions.set(source,28+source);assert(canAbilityTransit(f.context(),owner,f.through));
});
for(const owner of [0,6])test(`${owner}: Winged Terror protects its team; Air Power only its holder; original Ghost/Ground exemptions apply`,t=>{
 for(const ability of [1446,1450]){const f=fixture(t,owner),source=f.enemy+1;f.figure(source).pokepower=ability;f.match.positions.set(source,0);f.figure(owner).id=1005;assert.equal(canAbilityTransit(f.context(),owner,f.through),ability===1450);for(const id of [1106,1131]){f.figure(owner).id=id;assert(canAbilityTransit(f.context(),owner,f.through));}f.figure(owner).id=1005;f.figure(source).pokepower=-1;f.figure(owner+1).pokepower=ability;f.match.positions.set(owner+1,0);f.match.positions.set(source,28+source);assert(canAbilityTransit(f.context(),owner,f.through),'friendly aura does not suppress own mover');}
});
for(const owner of [0,6])test(`${owner}: Otherworldly Talons prevents opposing adjacent MP starts including empty routes, not far/allied moves`,t=>{
 const f=fixture(t,owner),source=f.through;f.figure(source).pokepower=1244;assert.deepEqual(movementMpBlockers(f.context(),owner),[{source,pokepower:1244}]);assert.deepEqual(engine.legalRoutes(f.match,side(owner)).filter(m=>m.value.route[0]===f.route[0]),[]);
 f.match.positions.set(source,0);assert.equal(movementMpBlockers(f.context(),owner).length,0);assert(engine.legalRoutes(f.match,side(owner)).some(m=>m.value.route[0]===f.route[0]));
 f.figure(source).pokepower=-1;f.figure(owner+1).pokepower=1244;f.match.positions.set(owner+1,f.route[1]);assert.equal(movementMpBlockers(f.context(),owner).length,0);
});
for(const owner of [0,6])test(`${owner}: unknown Earthen Rage adjacent barrier scope withholds intersecting new transit routes`,t=>{
 const f=fixture(t,owner),source=f.enemy+1;f.figure(source).pokepower=1472;f.match.positions.set(source,owner===0?10:27);assert.equal(unverifiedTransitRouteBlockers(f.context(),owner,f.route)[0].reason,'earthen_rage_traversal_scope_unverified');assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));
 f.match.positions.set(source,0);assert.equal(unverifiedTransitRouteBlockers(f.context(),owner,f.route).length,0);assert(engine.validateMovement(f.match,side(owner),f.move(f.route)));
});
for(const owner of [0,6])test(`${owner}: 256 seeded occupancy masks match independent path enumeration; all endpoints vacant`,()=>{
 let seed=0x662341+owner;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
 for(let trial=0;trial<256;trial++){
  const f=fixture(null,owner),maximum=1+random(3),available=Array.from({length:28},(_,p)=>p),pick=()=>available.splice(random(available.length),1)[0];f.figure(owner).mp=maximum;f.match.positions.set(owner,pick());for(const p of [f.enemy,f.enemy+1,owner+1,owner+2])f.match.positions.set(p,pick());
  const occupied=new Set([...f.match.positions.values()].filter(p=>p>=0&&p<28)),start=f.match.positions.get(owner),expected=[];
  const visit=route=>{if(route.length>maximum)return;for(const neighbor of adjacent(route.at(-1))){if(route.includes(neighbor))continue;const next=[...route,neighbor];if(!occupied.has(neighbor))expected.push(JSON.stringify(next));visit(next);}};visit([start]);
  const actual=engine.legalRoutes(f.match,side(owner),{allowedPokemon:owner}).map(m=>m.value.route);assert.deepEqual(actual.map(r=>JSON.stringify(r)).sort(),expected.sort());assert(actual.every(r=>!occupied.has(r.at(-1))&&r.length-1<=maximum));
 }
});
