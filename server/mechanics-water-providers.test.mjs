import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {hasMovementTransit,movementTransitContext,providerMovementTransitGrants,canAbilityTransit} from './movement-transit.mjs';
import {damageAuraSources,applyDamageAuras} from './damage-auras.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/water-provider-contract.json',import.meta.url))),catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url))).figures,edges=customMatchContract.fieldEdges;
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'],conditions=['normal',...special,'faint','curse'],side=p=>p<6?'black':'white',other=p=>p<6?6:0;
const skill=(id=1199,color=1,power=50,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner=0,ability=1345,allied=false){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('water-provider-isolated');
 for(const player of match.record.players){player.plates=[];for(const f of player.pokemons){f.id=1005;f.pokepower=-1;f.mp=2;f.skills=[skill()];}}
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p),enemy=other(owner),source=owner+2,through=allied?owner+1:enemy,route=owner===0?[15,11,6]:[11,15,20];
 figure(source).pokepower=ability;figure(source).id=ability===1345?1371:1543;match.positions.set(owner,route[0]);match.positions.set(through,route[1]);match.positions.set(source,owner===0?22:1);match.turn=side(owner);match.turns={black:1,white:1};
 return {service,match,figure,source,through,owner,enemy,route,context(){return movementTransitContext(match.record,match.positions,match.conditions,edges,match.waits)},move(route){return {selective_side:side(owner),value:{type:'mp_move',route}}}};
}
test('Sprinkler and Jet Current exact original text distinguishes healthy source from healthy mover',()=>{
 const expected={1345:'If this Pokémon is on the field and is not affected by a special condition, your Water-type Pokémon can MP move through other Water-type Pokémon.',1468:'If this Pokémon is on the field, your Water-type Pokémon that are not affected by special conditions may MP move through other Pokémon. Your Water-type and Dark-type Pokémon each deal +10 damage.'};
 for(const id of [1345,1468]){const entry=contract.descriptions.find(d=>d.key==='ability:'+id);assert(entry.evidence.some(e=>e.text===expected[id]));assert.deepEqual(entry.figures,[id===1345?1371:1543]);}
});
for(const owner of [0,6])for(const ability of [1345,1468])for(const allied of [false,true])test(`${owner}: provider${ability} ${allied?'allied':'opposing'} live condition gates attach to the correct figure`,()=>{
 const f=fixture(owner,ability,allied);assert(hasMovementTransit(f.match.record,f.match.positions));
 for(const sourceCondition of conditions)for(const moverCondition of conditions){
  f.match.conditions.set(f.source,sourceCondition);f.match.conditions.set(owner,moverCondition);f.match.waits.set(f.source,3);f.match.waits.set(f.through,3);
  const permitted=ability===1345?!special.includes(sourceCondition):!special.includes(moverCondition);
  assert.equal(providerMovementTransitGrants(f.context(),owner,f.through).length,permitted?1:0);
  if(moverCondition!=='faint')assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),permitted&&!['sleep','freeze','melt'].includes(moverCondition));
 }
});
for(const ability of [1345,1468])test(`provider${ability} every original type alias and no invented per-record type overrides`,()=>{
 const f=fixture(0,ability);
 for(const [id,row] of Object.entries(catalog)){
  const water=row.playable&&[row.type0,row.type1].includes(8);f.figure(0).id=Number(id);f.figure(0).type=8;f.figure(0).type0=8;
  assert.equal(providerMovementTransitGrants(f.context(),0,6).length,water?1:0,'mover '+id);
  f.figure(0).id=1005;f.figure(6).id=Number(id);assert.equal(providerMovementTransitGrants(f.context(),0,6).length,ability===1468||water?1:0,'occupant '+id);f.figure(6).id=1005;
 }
 f.figure(0).id=900000099;assert.equal(providerMovementTransitGrants(f.context(),0,6).length,0);f.figure(0).id=1005;f.figure(6).id=900000099;assert.equal(providerMovementTransitGrants(f.context(),0,6).length,ability===1468?1:0);
});
for(const owner of [0,6])for(const ability of [1345,1468])test(`${owner}: provider${ability} source ownership, self inclusion, duplicates, field scope and live departure`,()=>{
 const f=fixture(owner,ability);assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[{source:f.source,pokepower:ability}]);
 for(const point of [-1,28+f.source,40,41,42,43]){f.match.positions.set(f.source,point);assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[]);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));}
 f.figure(f.source).pokepower=-1;f.figure(f.enemy).pokepower=ability;assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[]);
 f.figure(f.enemy).pokepower=-1;f.figure(owner).pokepower=ability;assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[{source:owner,pokepower:ability}]);
 f.figure(f.source).pokepower=ability;f.match.positions.set(f.source,owner===0?22:1);assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[{source:owner,pokepower:ability},{source:f.source,pokepower:ability}]);
 if(ability===1345){f.match.conditions.set(owner,'poison');assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[{source:f.source,pokepower:ability}]);}
 f.match.conditions.set(owner,'normal');for(const point of [-1,28+owner,40,41,42,43]){f.match.positions.set(owner,point);assert.deepEqual(providerMovementTransitGrants(f.context(),owner,f.through),[]);}
});
for(const owner of [0,6])for(const ability of [1345,1468])test(`${owner}: provider${ability} authoritative MP path retains endpoints, cost, blockers and command atomicity`,t=>{
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const f=fixture(owner,ability),errors=[];f.match.phase='started';f.match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};f.service.playOpponentTurn=()=>{};f.service.rejectPlayerMove=(_m,e)=>errors.push(e);t.after(()=>{f.match.phase='finished'});
 const send=value=>f.service.acceptPlayerMove(f.match,value,value.selective_side),snapshot=()=>JSON.stringify({record:f.match.record,positions:[...f.match.positions],waits:[...f.match.waits],conditions:[...f.match.conditions],ledger:f.match.completedTurnLedger});
 for(const route of [f.route.slice(0,2),[...f.route,f.route[1]],[28+owner,owner===0?27:6]]){const before=snapshot();assert(!engine.validateMovement(f.match,side(owner),f.move(route)));send(f.move(route));assert.equal(errors.pop(),'illegal_player_movement');assert.equal(snapshot(),before);}
 for(const mp of [0,1,2,3]){f.figure(owner).mp=mp;assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),mp>=2);}f.figure(owner).mp=2;
 f.match.record.first_player=side(owner);f.match.turns[side(owner)]=0;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.turns[side(owner)]=1;
 f.match.waits.set(owner,1);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.waits.set(owner,0);
 for(const blocker of [1032,1051,1249,1300,1408,1446,1450,1244,1472]){f.figure(f.through).pokepower=blocker;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)),String(blocker));}
 f.figure(f.through).pokepower=-1;const before=[...f.match.positions];send(f.move(f.route));assert.deepEqual(errors,[]);assert.equal(f.match.positions.get(owner),f.route.at(-1));for(const [p,point] of before)if(p!==owner)assert.equal(f.match.positions.get(p),point);
 send({selective_side:side(owner),value:{type:'null_move'}});assert.equal(f.match.turn,side(f.enemy));assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);assert.equal(new Set(f.match.positions.values()).size,12);
 const final=snapshot();send(f.move(f.route));assert.equal(errors.pop(),'stale_player_turn');assert.equal(snapshot(),final);
});
for(const owner of [0,6])test(`${owner}: Jet Current Water or Dark damage grants one term per source and retains health independence`,()=>{
 const f=fixture(owner,1468);for(const id of [1005,1177,1543,1022])for(const color of [0,1,2,3,4])for(const sourceCondition of conditions)for(const targetCondition of ['normal','poison','paralyze']){
  f.figure(owner).id=id;f.match.conditions.set(f.source,sourceCondition);f.match.conditions.set(owner,targetCondition);const expected=[1005,1177,1543].includes(id)&&[1,3].includes(color)?10:0,s=skill(1199,color,50);
  applyDamageAuras(f.match.record,f.match.positions,f.match.conditions,owner,s);assert.equal(s.speed_or_damage,50+expected);assert.equal(s.damage_aura_changes?.length??0,expected?1:0);
  if(expected)assert.deepEqual(s.damage_aura_changes,[{source:f.source,pokepower:1468,addend:10,current:50,result:60}]);
 }
 f.figure(owner).id=1543;f.figure(owner).pokepower=1468;f.match.conditions.clear();const s=skill();applyDamageAuras(f.match.record,f.match.positions,f.match.conditions,owner,s);assert.equal(s.speed_or_damage,70);assert.deepEqual(s.damage_aura_changes.map(c=>c.source),[owner,f.source]);
 f.figure(owner).pokepower=-1;f.match.positions.set(f.source,28+f.source);assert.deepEqual(damageAuraSources(f.match.record,f.match.positions,f.match.conditions,owner,skill()),[]);f.figure(f.enemy).pokepower=1468;assert.deepEqual(damageAuraSources(f.match.record,f.match.positions,f.match.conditions,owner,skill()),[]);
});
test('Jet Current damage uses canonical Water/Dark union for every original alias',()=>{
 const f=fixture(0,1468);for(const [id,row] of Object.entries(catalog)){f.figure(0).id=Number(id);const eligible=row.playable&&[row.type0,row.type1].some(type=>[8,0].includes(type));assert.equal(damageAuraSources(f.match.record,f.match.positions,f.match.conditions,0,skill()).length,eligible?1:0,id);}
 f.figure(0).id=900000099;assert.deepEqual(damageAuraSources(f.match.record,f.match.positions,f.match.conditions,0,skill()),[]);
});
for(const owner of [0,6])test(`${owner}: Jet Current participates in actual battle comparison and repeat/plate/condition arithmetic`,()=>{
 for(const offset of [-1,0,1]){const f=fixture(owner,1468);f.figure(f.enemy).skills=[skill(1199,1,60+offset)];const r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(r.attackerSkill.speed_or_damage,60);assert.equal(r.winner,offset<0?owner:offset>0?f.enemy:-1);}
 for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676]){
  const f=fixture(owner,1468),repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id),units=repeat?[0,0,0,48]:[0,0],raw=repeat?150:id===1301?70:100;
  f.figure(owner).skills=[skill(id,1,50,48),skill(1131,0,0,48)];f.match.damageBonuses.set(owner,30);f.match.conditions.set(owner,'poison');const selected=engine.selectedSpinSkill(f.match,owner,units.map((num,i)=>({num,displace:0,type:i?'probability':'battle'})));engine.applyConditionBattleDamage(f.match,owner,f.enemy,selected);assert.equal(selected.speed_or_damage,raw+10+30-20);assert.deepEqual(selected.damage_aura_changes,[{source:f.source,pokepower:1468,addend:10,current:raw,result:raw+10}]);
 }
});
