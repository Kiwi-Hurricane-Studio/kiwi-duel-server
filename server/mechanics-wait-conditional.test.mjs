import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract} from './custom-match-engine.mjs';
import {waitImmunityAbility,waitTargets,applyWait} from './wait-immunity.mjs';
import {hasMovementTransit,movementTransitContext,conditionalMovementTransitGrant,canAbilityTransit} from './movement-transit.mjs';
import {inspectLedger} from './completed-turn-ledger.mjs';
const edges=customMatchContract.fieldEdges,side=p=>p<6?'black':'white',other=p=>p<6?6:0;
const attack=(id,color=2,power=3)=>({id,color,speed_or_damage:power,range:96});
function fixture(owner=0,id=1566){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('wait-conditional-isolated');
 for(const player of match.record.players){player.plates=[];for(const figure of player.pokemons){figure.id=1005;figure.mp=2;figure.pokepower=-1;figure.skills=[attack(1199,1,50)];}}
 const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p),enemy=other(owner);
 figure(owner).skills=[attack(id)];match.positions.set(0,15);match.positions.set(6,11);match.turn=side(owner);
 return {service,match,figure,owner,enemy,resolve(defending=false){return service.applyBaseBattleOutcome(match,defending?enemy:owner,defending?owner:enemy,0,0);}};
}
const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/wait-conditional-contract.json',import.meta.url)));
test('three exact original descriptions and two bound figures define the partial clauses',()=>{
 const expected={1055:'This Pokémon cannot have Wait.',1200:'This Pokémon can MP move through Pokémon that have Wait. If this Pokémon has evolved, this Pokémon on your bench gains +1 MP.',1215:'This Pokémon cannot have Wait. Can MP Move through Pokémon on the field that are paralyzed or have Wait.'};
 for(const [id,text] of Object.entries(expected)){const row=contract.descriptions.find(d=>d.key==='ability:'+id);assert(row.evidence.some(e=>e.text===text));assert.deepEqual(row.figures,id==='1055'?[]:id==='1200'?[1293]:[1093]);}
});
for(const owner of [0,6])for(const ability of [1055,1215])test(`${owner}: ${ability} Wait immunity has no health, field or duration gate; recovery remains separate`,()=>{
 const f=fixture(owner);f.figure(owner).pokepower=ability;f.figure(owner).id=ability===1215?1093:1005;
 for(const point of [-1,0,15,28+owner,owner===0?40:42,owner===0?41:43])for(const condition of ['normal','poison','bad_poison','burn','sleep','freeze','melt','panic','paralyze','faint','curse'])for(const duration of [1,2,3,7,9]){
  f.match.positions.set(owner,point);f.match.conditions.set(owner,condition);f.match.waits.set(owner,0);
  assert.equal(waitImmunityAbility(f.match.record,owner),ability);assert.equal(applyWait(f.match.record,f.match.waits,owner,duration),false);assert.equal(f.match.waits.get(owner),0);
  assert.equal(f.match.conditions.get(owner),condition);assert.equal(f.match.positions.get(owner),point);
 }
 f.match.waits.set(owner,3);assert.equal(applyWait(f.match.record,f.match.waits,owner,0),true);assert.equal(f.match.waits.get(owner),0);
 const targets=[f.enemy,owner,f.enemy+1];assert.deepEqual(waitTargets(f.match.record,targets),[f.enemy,f.enemy+1]);assert.deepEqual(targets,[f.enemy,owner,f.enemy+1]);
});
test('unknown abilities and missing or invalid actors do not fabricate Wait immunity',()=>{
 const f=fixture();for(const ability of [-1,1200,999999]){f.figure(0).pokepower=ability;assert.equal(waitImmunityAbility(f.match.record,0),null);assert(applyWait(f.match.record,f.match.waits,0,7));assert.equal(f.match.waits.get(0),7);}
 for(const p of [-1,12,0.5,NaN]){assert.equal(waitImmunityAbility(f.match.record,p),null);assert.equal(applyWait(f.match.record,f.match.waits,p,3),false);}
 for(const duration of [-1,0.5,NaN,Infinity])assert.equal(applyWait(f.match.record,f.match.waits,0,duration),false);
 assert.equal(waitImmunityAbility({},0),null);
});
const purple=[{id:1471,condition:'paralyze',wait:3},{id:1524,condition:'burn',wait:3},{id:1532,wait:3},{id:1566,wait:3},{id:1598,condition:'poison',wait:7}];
for(const owner of [0,6])for(const ability of [1055,1215])for(const rule of purple)test(`${owner}: ${ability} filters Purple${rule.id} Wait independently of condition and target selection`,()=>{
 for(const defending of [false,true])for(const prior of ['normal','poison','sleep']){
  const f=fixture(owner,rule.id);f.figure(f.enemy).pokepower=ability;f.match.conditions.set(f.enemy,prior);const result=f.resolve(defending);
  assert.equal(result.winner,owner);assert.deepEqual(result.purpleWaitPlan.targets,[f.enemy]);assert.deepEqual(result.purpleWaitPlan.wait_targets,[]);assert.equal(f.match.waits.get(f.enemy),0);assert.equal(f.match.conditions.get(f.enemy),rule.condition??prior);assert.equal(f.match.positions.get(f.enemy),f.enemy===6?11:15);
 }
});
for(const owner of [0,6])for(const ability of [1055,1215])test(`${owner}: ${ability} group Wait passes an immune bridge without losing ordinary targets`,()=>{
 for(const id of [1524,1532,1717]){
  const f=fixture(owner,id),places=f.enemy===6?[11,6,5]:[15,20,27];
  for(let i=0;i<3;i++)f.match.positions.set(f.enemy+i,places[i]);f.figure(f.enemy).pokepower=ability;
  const r=f.resolve();assert.equal(f.match.waits.get(f.enemy),0);assert.equal(f.match.waits.get(f.enemy+1),id===1717?9:3);assert.equal(f.match.waits.get(f.enemy+2),id===1532?3:0);
  if(id===1524){assert.equal(f.match.conditions.get(f.enemy),'burn');assert.equal(f.match.conditions.get(f.enemy+1),'burn');}
  if(id===1532)assert.deepEqual(r.purpleWaitPlan.wait_targets,[f.enemy+1,f.enemy+2]);
 }
});
for(const owner of [0,6])for(const ability of [1055,1215])test(`${owner}: ${ability} retains every bench destination and independent cleanup while preventing Wait`,()=>{
 for(const id of [1027,1052,1098,1329,1467,1499,1630])for(const defending of [false,true]){
  const f=fixture(owner,id),target=id===1467?owner:f.enemy;f.figure(target).pokepower=ability;f.match.conditions.set(target,'poison');const r=f.resolve(defending);
  assert.equal(r.winner,owner);assert.equal(f.match.positions.get(target),28+target);assert.equal(f.match.conditions.get(target),'normal');assert.equal(f.match.waits.get(target),0);assert(!r.benchTransfer.wait_targets.includes(target));assert.equal(new Set(f.match.positions.values()).size,12);
 }
});
for(const owner of [0,6])for(const ability of [1055,1215])test(`${owner}: ${ability} conditional effect KO reads prior condition and preserves its own result`,()=>{
 for(const id of [1487,1544])for(const prior of ['normal','poison']){
  const f=fixture(owner,id);f.figure(f.enemy).pokepower=ability;f.match.conditions.set(f.enemy,prior);const r=f.resolve();
  assert.deepEqual(r.effectKnockoutPlan.wait_targets,[]);assert.equal(f.match.waits.get(f.enemy),0);assert.deepEqual(r.pendingKnockoutTargets??[],prior==='normal'?[]:[f.enemy]);assert.equal(f.match.conditions.get(f.enemy),prior==='normal'?'normal':'faint');
 }
});
for(const owner of [0,6])for(const ability of [1055,1215])test(`${owner}: ${ability} covers Blackout, Rock Slide, Dodge, Substitute and Center release`,()=>{
 // A draw lets the defeated-side ordering and surviving Blackout target be
 // observed without a damage knockout moving it out of Blackout's scope.
 let f=fixture(owner);f.figure(owner).pokepower=1326;f.figure(f.enemy).pokepower=ability;f.figure(owner).skills=[attack(1199,1,50)];f.resolve();assert.equal(f.match.conditions.get(f.enemy),'paralyze');assert.equal(f.match.waits.get(f.enemy),0);
 f=fixture(owner,1140);f.figure(owner).skills=[attack(1140,1,50)];f.figure(f.enemy).pokepower=ability;f.match.positions.set(f.enemy+1,f.enemy===6?6:20);f.resolve();assert.equal(f.match.waits.get(f.enemy),0);assert.equal(f.match.waits.get(f.enemy+1),3);assert.equal(f.match.conditions.get(f.enemy),'normal');
 f=fixture(owner,1127);f.figure(owner).skills=[attack(1127,4,0)];f.figure(owner).pokepower=ability;f.resolve();assert.equal(f.match.waits.get(owner),0);assert.equal(f.match.positions.get(owner),owner===0?15:11);
 f=fixture(owner,1536);f.figure(owner).skills=[attack(1536,1,90)];f.figure(f.enemy).pokepower=ability;assert.equal(f.resolve().knockout,true);assert.equal(f.match.positions.get(f.enemy),f.enemy===6?43:41);assert.equal(f.match.waits.get(f.enemy),0);
 f=fixture(owner);f.figure(owner).skills=[attack(1199,1,90)];const upper=f.enemy===6?43:41;f.match.positions.set(f.enemy+1,upper-1);f.match.positions.set(f.enemy+2,upper);f.figure(f.enemy+1).pokepower=ability;f.match.conditions.set(f.enemy+1,'poison');
 assert.equal(f.resolve().knockout,true);assert.equal(f.match.positions.get(f.enemy+1),28+f.enemy+1);assert.equal(f.match.positions.get(f.enemy+2),upper-1);assert.equal(f.match.conditions.get(f.enemy+1),'normal');assert.equal(f.match.waits.get(f.enemy+1),0);assert.equal(new Set(f.match.positions.values()).size,12);
});
function moving(t,owner,ability,allied=false){
 t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));const f=fixture(owner);f.figure(owner).pokepower=ability;f.figure(owner).id=ability===1200?1293:1093;
 const errors=[];f.service.playOpponentTurn=()=>{};f.service.rejectPlayerMove=(_m,why)=>errors.push(why);f.match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};f.match.phase='started';f.match.turns={black:1,white:1};t.after(()=>{f.match.phase='finished'});
 const through=allied?owner+1:f.enemy,route=owner===0?[15,11,6]:[11,15,20];f.match.positions.set(f.enemy,28+f.enemy);f.match.positions.set(through,route[1]);
 return Object.assign(f,{errors,through,route,context(){return movementTransitContext(f.match.record,f.match.positions,f.match.conditions,edges,f.match.waits)},move(route){return {selective_side:side(owner),value:{type:'mp_move',route}}},send(move){f.service.acceptPlayerMove(f.match,move,move.selective_side)}});
}
for(const owner of [0,6])for(const ability of [1200,1215])for(const allied of [false,true])test(`${owner}: ${ability} ${allied?'allied':'opposing'} condition-specific traversal uses live state and retains vacant endpoints`,t=>{
 const f=moving(t,owner,ability,allied);assert(hasMovementTransit(f.match.record,f.match.positions));
 for(const condition of ['normal','paralyze','poison','bad_poison','burn','sleep','freeze','melt','panic','faint','curse'])for(const wait of [0,1,3]){
  f.match.conditions.set(f.through,condition);f.match.waits.set(f.through,wait);const permitted=wait>0||ability===1215&&condition==='paralyze';
  assert.equal(!!conditionalMovementTransitGrant(f.context(),owner,f.through),permitted);
  // Independent no-sphere-frozen-allied/opposing native histories establish
  // base frozen-figure transit even when this ability grants no passage.
  assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),permitted||['freeze','sleep'].includes(condition));
  assert(!engine.validateMovement(f.match,side(owner),f.move(f.route.slice(0,2))));assert(!engine.validateMovement(f.match,side(owner),f.move([...f.route,f.route[1]])));
 }
 f.match.conditions.set(f.through,'normal');f.match.waits.set(f.through,3);const before=[...f.match.positions];f.send(f.move(f.route));assert.deepEqual(f.errors,[]);assert.equal(f.match.positions.get(owner),f.route.at(-1));for(const [p,point] of before)if(p!==owner)assert.equal(f.match.positions.get(p),point);
 if(!allied)f.send({selective_side:side(owner),value:{type:'null_move'}});
 assert.equal(f.match.turn,side(f.enemy));assert.equal(f.match.waits.get(f.through),2);assert.equal(inspectLedger(f.match.completedTurnLedger,f.match.record).state.completed_turns,1);assert.equal(new Set(f.match.positions.values()).size,12);
 const record=JSON.stringify(f.match.record);f.send(f.move(f.route));assert.equal(f.errors.pop(),'stale_player_turn');assert.equal(JSON.stringify(f.match.record),record);
});
for(const owner of [0,6])for(const ability of [1200,1215])test(`${owner}: ${ability} preserves blockers, MP costs, use restrictions and field-start scope`,t=>{
 const f=moving(t,owner,ability);f.match.waits.set(f.through,3);
 for(const blocker of [1032,1051,1249,1408,1300,1450,1446]){f.figure(f.through).pokepower=blocker;assert(!canAbilityTransit(f.context(),owner,f.through));assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));}
 f.figure(f.through).pokepower=-1;
 for(const mp of [0,1,2,3]){f.figure(owner).mp=mp;assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),mp>=2);}f.figure(owner).mp=2;
 f.match.record.first_player=side(owner);f.match.turns[side(owner)]=0;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.turns[side(owner)]=1;
 for(const condition of ['normal','sleep','freeze','melt','poison','paralyze']){f.match.conditions.set(owner,condition);assert.equal(engine.validateMovement(f.match,side(owner),f.move(f.route)),!['sleep','freeze','melt'].includes(condition));}f.match.conditions.set(owner,'normal');
 f.match.waits.set(owner,1);assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.match.waits.set(owner,0);
 f.figure(f.through).pokepower=1244;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));f.figure(f.through).pokepower=1472;assert(!engine.validateMovement(f.match,side(owner),f.move(f.route)));
 f.figure(f.through).pokepower=-1;for(const point of [-1,28+owner,40,41,42,43]){f.match.positions.set(owner,point);assert.equal(conditionalMovementTransitGrant(f.context(),owner,f.through),null);}
});
