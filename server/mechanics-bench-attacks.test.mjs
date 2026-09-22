import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';
import {benchAttackPlan} from './bench-attacks.mjs';

const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url)));
const catalog=read('../docs/generated/mechanics-20260913/coverage.json');
const masters=read('../data/figure_master_map.json').skill_masters;
const primary=read('../docs/generated/mechanics-20260913/native-multispin.json').cases.find(c=>c.name.endsWith('purple-primary-1018'));
const ids=[1027,1098,1329,1499],protection=[1007,1018,1226,1307,1310,1372,1425,1426];
const attack=(id=1199,color=1,range=96,power=100)=>({id,color,range,speed_or_damage:power});
function fixture(owner,id=1027,ability=-1) {
  const service=new CustomMatchService({port:0}),match=service.createMatch('bench-isolated'),enemy=owner===0?6:0;
  const figures=match.record.players.flatMap(p=>p.pokemons);
  for(const p of figures){p.pokepower=-1;p.skills=[attack()];}
  const target=figures.find(p=>p.pokemon_index===owner),emitter=figures.find(p=>p.pokemon_index===enemy);
  target.pokepower=ability;emitter.skills=[attack(id,2,96,2)];match.positions.set(0,15);match.positions.set(6,11);
  return {service,match,owner,enemy,target,emitter};
}
test('all identical original bench-and-Wait descriptions and their format are mapped',()=>{
  const data=read('../data/bench_attack_rules.json');
  assert.deepEqual(Object.values(masters).filter(m=>m.skill_color===2&&m.description===data.description).map(m=>m.skill_master_id).sort((a,b)=>a-b),ids);
  for(const id of ids)assert.equal(masters[id].format_type,0);
  const text=read('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json').resources.localization_phase_1;
  for(const id of protection)assert(text.some(row=>row.text_key===`FigureMaster.PokepowerDescription.${id}`&&/cannot be moved/i.test(row.text)),String(id));
});
for(const id of ids)test(`bench ${id}: every original range/star variant, both owners, all colors and Purple star comparisons`,()=>{
  const variants=catalog.entries.find(e=>e.key===`skill:${id}`).variants;assert(variants.length);
  for(const v of variants)for(const owner of [0,6])for(const color of [0,1,2,3,4])for(const opposingStars of [v.stars-1,v.stars,v.stars+1])for(const miss of [false,true]) {
    assert(v.range>0&&v.range<96&&v.stars>0);
    const f=fixture(owner,id);
    f.emitter.skills=[attack(id,2,v.range,v.stars),attack(1131,0,96-v.range,0)];
    f.target.skills=[attack([1131,1199,1085,1003,1122][color],color,96,color===2?opposingStars:color===1||color===3?100:0)];
    const result=f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,miss?v.range:v.range-1,0);
    const success=!miss&&(color<2||color===2&&v.stars>opposingStars);
    assert.equal(f.match.positions.get(owner),success?28+owner:owner===0?15:11);
    assert.equal(f.match.waits.get(owner),success?2:0);
    assert.equal(!!result.benchTransfer,success);
    if(success){assert.equal(result.knockout,false);assert.equal(result.winner,f.enemy);assert.equal(f.match.battledAfterField.get(owner),false);}
    assert.equal(new Set(f.match.positions.values()).size,12);f.match.phase='finished';
  }
});
test('bench clears every special condition and disabled wheel, keeps Center occupants, and resets field-entry history',()=>{
  for(const id of ids)for(const owner of [0,6])for(const condition of ['normal','bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']) {
    const f=fixture(owner,id);f.target.skills=[attack(1131,0,96,0)];
    f.match.conditions.set(owner,condition);f.match.waits.set(owner,4);f.match.disabledSkills.set(owner,new Set([1199]));f.match.battledAfterField.set(owner,true);
    const center=owner===0?[40,41]:[42,43];f.match.positions.set(owner+1,center[0]);f.match.positions.set(owner+2,center[1]);
    const result=f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(result.knockout,false);assert.equal(f.match.positions.get(owner),28+owner);assert.equal(f.match.conditions.get(owner),'normal');
    assert.equal(f.match.waits.get(owner),2);assert.equal(f.match.disabledSkills.has(owner),false);assert.equal(f.match.battledAfterField.get(owner),false);
    assert.deepEqual([f.match.positions.get(owner+1),f.match.positions.get(owner+2)],center);assert.equal(new Set(f.match.positions.values()).size,12);f.match.phase='finished';
  }
});
for(const ability of protection)test(`movement protection ${ability}: preserves field and condition; independent Wait clause remains derived`,()=>{
  for(const id of ids)for(const owner of [0,6]) {
    const f=fixture(owner,id,ability);f.target.skills=[attack(1131,0,96,0)];f.match.conditions.set(owner,'panic');
    const result=f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(result.benchTransfer.blocked_by,ability);assert.equal(f.match.positions.get(owner),owner===0?15:11);
    assert.equal(f.match.conditions.get(owner),'panic');assert.equal(f.match.waits.get(owner),2);assert.equal(f.match.battledAfterField.get(owner),true);f.match.phase='finished';
  }
});
test('special-condition immunity does not prevent bench movement; ordinary damage still uses the Center',()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,1027,1427);f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);assert.equal(f.match.positions.get(owner),28+owner);
    f.match.positions.set(owner,owner===0?15:11);f.emitter.skills=[attack()];f.target.skills=[attack(1131,0,96,0)];
    assert.equal(f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0).knockout,true);assert.equal(f.match.positions.get(owner),owner===0?41:43);f.match.phase='finished';
  }
});
test('invalid bench targets and occupied own slots fail before outcome mutation',()=>{
  const f=fixture(0);const skill=attack(1027,2,96,2);
  for(const target of [-1,12,1.5,6])assert.throws(()=>benchAttackPlan(f.match.record,f.match.positions,6,target,skill),/invalid_bench_attack_target/);
  for(const point of [28,41,44,-1]){f.match.positions.set(0,point);assert.throws(()=>benchAttackPlan(f.match.record,f.match.positions,6,0,skill),/invalid_bench_attack_target/);}
  f.match.positions.set(0,15);f.match.positions.set(1,28);f.match.conditions.set(0,'panic');f.match.waits.set(0,4);
  const before=JSON.stringify([...[f.match.positions,f.match.conditions,f.match.waits,f.match.battledAfterField].map(m=>[...m])]);
  assert.throws(()=>f.service.applyBaseBattleOutcome(f.match,6,0,0,0),/occupied_bench_attack_destination/);
  assert.equal(JSON.stringify([...[f.match.positions,f.match.conditions,f.match.waits,f.match.battledAfterField].map(m=>[...m])]),before);
  f.match.phase='finished';
});
test('Blackout targets must remain on the field; benched owner retaliation and re-entry remain a derived interaction',()=>{
  for(const owner of [0,6])for(const powerOwner of ['emitter','target']) {
    const f=fixture(owner);f[powerOwner].pokepower=1326;
    f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(f.match.conditions.get(owner),'normal');assert.equal(f.match.waits.get(owner),2);
    assert.equal(f.match.conditions.get(f.enemy),powerOwner==='target'?'paralyze':'normal');
    assert.equal(f.match.battledAfterField.get(owner),false);f.match.phase='finished';
  }
});
async function until(predicate,label){for(let i=0;i<250;i++){if(predicate())return;await delay(5);}assert.fail(label);}
async function accepted(owner,id,mode='base') {
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opponent=owner===0?'white':'black';
  const queues=new Map([[owner,mode==='secondary'?[0]:[0,0]],[enemy,mode==='respin'?[0,48,0]:mode==='secondary'?[48]:[0,48]]]);
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:(_,p)=>queues.get(p)?.shift()});
  const rejected=[];let pending=null;
  service.playOpponentTurn=()=>{};service.declareOpponentRespin=()=>{};service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  if(mode==='secondary')service.scheduleSecondarySpins=(_,value)=>pending=value;
  const match=service.createMatch('accepted-bench-two-battles');match.record=structuredClone(primary.record);match.record.all_moves=[];match.plateState=null;
  match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const player of match.record.players){if(player.color===opponent)player.plates=[5015];for(const p of player.pokemons){p.pokepower=-1;p.skills=[attack()];
    if(p.pokemon_index===owner)p.skills=[attack(mode==='secondary'?1001:1199,1,96,100)];
    if(p.pokemon_index===enemy)p.skills=[attack(1009,2,48,2),attack(id,2,48,2)];}}
  const actions=structuredClone(primary.record.all_moves.slice(0,-1));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejected,[]);};
  try {
    for(const action of actions)accept(action);
    if(mode==='secondary') {
      await until(()=>!match.battleResolutionPending,'bench suppresses losing Ice Shard');assert.equal(pending,null);
      return {service,match,accept,owner,enemy,side,opponent,queues,pending};
    }
    await until(()=>!match.battleResolutionPending,'initial panic resolves');assert.equal(match.conditions.get(owner),'panic');
    accept({selective_side:side,value:{type:'mp_move',route:owner===0?[29,21]:[35,0]}});
    if(['decline','respin'].includes(mode))accept({selective_side:opponent,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:enemy}}});
    accept({selective_side:opponent,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}});
    await until(()=>mode==='secondary'?!!pending:['decline','respin'].includes(mode)?!!match.pendingRespin:!match.battleResolutionPending,'bench resolution boundary');
    return {service,match,accept,owner,enemy,side,opponent,queues,pending};
  }catch(error){match.phase='finished';throw error;}
}
for(const id of ids)for(const owner of [0,6])test(`accepted bench ${id} owner ${owner}: panic cleanup, Wait aging, rejected early entry and legal re-entry`,async()=>{
  const f=await accepted(owner,id);
  try {
    assert.equal(f.match.positions.get(owner),28+owner);assert.equal(f.match.conditions.get(owner),'normal');assert.equal(f.match.waits.get(owner),1);
    const route=owner===0?[28,27]:[34,6];const entry={selective_side:f.side,value:{type:'mp_move',route}};
    assert.equal(rules.validateMovement(f.match,f.side,entry),false,'Wait prevents immediate bench entry');
    f.accept({selective_side:f.side,value:{type:'mp_move',route:owner===0?[21,22]:[0,1]}});assert.equal(f.match.waits.get(owner),0);
    f.accept({selective_side:f.opponent,value:{type:'mp_move',route:owner===0?[35,0]:[29,21]}});
    f.accept(entry);assert.equal(f.match.positions.get(owner),route.at(-1));assert.equal(f.match.battledAfterField.get(owner),false);
    assert.equal(new Set(f.match.positions.values()).size,12);assert([...f.queues.values()].every(q=>q.length===0));
  }finally{f.match.phase='finished';}
});
for(const owner of [0,6])for(const mode of ['decline','respin'])test(`bench owner ${owner}: Double Chance ${mode} holds and settles one outcome`,async()=>{
  const f=await accepted(owner,1027,mode);
  try {
    assert.equal(f.match.positions.get(owner),owner===0?15:11);assert.equal(f.match.conditions.get(owner),'panic');assert.equal(f.match.waits.get(owner),0);
    f.accept({selective_side:f.opponent,value:mode==='decline'?{type:'null_move'}:{type:'declare_respin',pokemons:[f.enemy]}});
    await until(()=>!f.match.battleResolutionPending,'Double Chance finalized');
    assert.equal(f.match.positions.get(owner),mode==='decline'?28+owner:owner===0?15:11);
    assert.equal(f.match.conditions.get(owner),mode==='decline'?'normal':'panic');assert.equal(f.match.waits.get(owner),mode==='decline'?1:0);
    assert.equal(f.match.record.all_moves.filter(m=>m.value.type==='spin').length,mode==='decline'?2:3);assert([...f.queues.values()].every(q=>q.length===0));
  }finally{f.match.phase='finished';}
});
for(const owner of [0,6])test(`bench owner ${owner}: Purple bench suppresses losing White Ice Shard and completes cleanup`,async()=>{
  const f=await accepted(owner,1027,'secondary');
  try {
    assert.equal(f.match.positions.get(owner),28+owner);assert.equal(f.match.waits.get(owner),1);assert.equal(f.match.battleResolutionPending,false);
    assert.equal(f.pending,null);assert.equal(f.match.pendingSecondarySpins,null);
    assert.equal(f.match.positions.get(owner),28+owner);assert.equal(f.match.conditions.get(owner),'normal');assert.equal(f.match.waits.get(owner),1);
    assert.equal(f.service.performSecondarySpins(f.match,f.pending),false);assert.equal(f.match.record.all_moves.filter(m=>m.value.type==='spin').length,1);
    assert([...f.queues.values()].every(q=>q.length===0));
  }finally{f.match.phase='finished';}
});
