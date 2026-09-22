import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';
import {repeatedSpinPresentationExtraMilliseconds} from './human-match-service.mjs';
const attack=(id,color,range,power=0)=>({id,color,range,speed_or_damage:power});
const repeats=[1168,1172,1201,1261,1273,1310,1361,1369,1596];
const retries=[[1283,50],[1301,20],[1307,50],[1492,50],[1533,50],[1676,50]];
const primary=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases.find(c=>c.name.endsWith('purple-primary-1009'));
function isolated(owner,skills) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('panic-wheel-isolated');
  const figure=match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===owner);
  figure.pokepower=-1;figure.skills=structuredClone(skills);match.conditions.set(owner,'panic');
  return {service,match,figure};
}
test('all729 original wheels use the signed displacement over positive-width segments',()=>{
  const {match,figure}=isolated(0,[]);
  for(const catalog of Object.values(JSON.parse(fs.readFileSync(new URL('../data/figure_battle_master_map.json',import.meta.url))).figures)) {
    figure.skills=catalog.skills.map(s=>attack(s.skill_master_id,s.color,s.range,s.power));
    const positive=figure.skills.filter(s=>s.range>0);let offset=0;
    for(const [index,segment] of positive.entries()) {
      for(const shift of [-2,-1,0,1,2,positive.length,positive.length+1]) for(const unit of [offset,offset+segment.range-1]) {
        const expected=positive[(index+shift%positive.length+positive.length)%positive.length];
        assert.equal(rules.selectedSkill(match,0,unit,shift).id,expected.id,`figure ${catalog.item_master_id},unit${unit},shift${shift}`);
      }
      offset+=segment.range;
    }
  }
  figure.skills=[attack(1199,1,48,50),attack(1122,4,0),attack(1131,0,48)];
  assert.equal(rules.selectedSkill(match,0,0,1).id,1131);
  assert.equal(rules.selectedSkill(match,0,48,1).id,1199);
  for(const shift of [NaN,Infinity,.5])assert.equal(rules.selectedSkill(match,0,0,shift),null);
});
for(const owner of [0,6]) test(`panic owner ${owner}: raw units remain in the command while one shift selects each color and wraps past zero-width pieces`,()=>{
  const {match}=isolated(owner,[attack(1131,0,16),attack(1370,1,0,90),attack(1199,1,16,50),attack(1122,4,16),attack(1009,2,16,2),attack(1003,3,16,80),attack(1199,1,16,50)]);
  for(const [unit,id,color] of [[0,1199,1],[16,1122,4],[32,1009,2],[48,1003,3],[64,1199,1],[80,1131,0]]) {
    const wheel=rules.rollBattleWheel(match,owner,()=>unit);
    assert.deepEqual(wheel,{pokemon:owner,results:[{displace:1,num:unit,type:'battle'}]});
    const selected=rules.selectedSpinSkill(match,owner,wheel.results);assert.equal(selected.id,id);assert.equal(selected.color,color);
    match.conditions.set(owner,'normal');
    assert.equal(rules.selectedSpinSkill(match,owner,wheel.results).id,id,'replay obeys recorded displacement, not later condition state');
    match.conditions.set(owner,'panic');
  }
});
for(const owner of [0,6]) test(`panic owner ${owner}: every repeated-hit variant triggers and terminates from the shifted selection`,()=>{
  for(const id of repeats) {
    const {match}=isolated(owner,[attack(1131,0,32),attack(id,1,32,50),attack(1003,3,32,80)]);
    const queue=[0,0,32];const wheel=rules.rollBattleWheel(match,owner,()=>queue.shift());
    assert.deepEqual(wheel.results,[{num:0,displace:1,type:'battle'},{num:0,displace:1,type:'probability'},{num:32,displace:1,type:'probability'}]);
    const result=rules.selectedSpinSkill(match,owner,wheel.results);assert.equal(result.id,id);assert.equal(result.speed_or_damage,100);
    assert.equal(result.repeat_extra_hits,1);assert.equal(queue.length,0);
    assert.equal(repeatedSpinPresentationExtraMilliseconds({spins:[wheel]}),3752,'extra stops include both displacement waits/tweens');
    let count=0;const away=rules.rollBattleWheel(match,owner,()=>{count++;return 32;});
    assert.equal(count,1);assert.equal(rules.selectedSpinSkill(match,owner,away.results).id,1003);
  }
});
for(const owner of [0,6]) test(`panic owner ${owner}: all six single-retry variants keep exactly one shifted retry`,()=>{
  for(const [id,bonus] of retries) for(const second of [0,32]) {
    const {match}=isolated(owner,[attack(1131,0,32),attack(id,1,32,50),attack(1003,3,32,80)]);
    const queue=[0,second];const wheel=rules.rollBattleWheel(match,owner,()=>queue.shift());
    assert.equal(queue.length,0);assert.equal(wheel.results.length,2);assert(wheel.results.every(r=>r.displace===1));
    const result=rules.selectedSpinSkill(match,owner,wheel.results);assert.equal(result.id,id);assert.equal(result.speed_or_damage,50+(second===0?bonus:0));
  }
});
test('panic spin guards fail without inventing a terminal segment, and Full Heal restores zero displacement',()=>{
  const f=isolated(0,[attack(1168,1,96,50)]);
  assert.throws(()=>rules.rollBattleWheel(f.match,0,()=>0),/repeated_spin_resource_limit/);
  for(const unit of [-1,96,NaN,Infinity,.5])assert.throws(()=>rules.rollBattleWheel(f.match,0,()=>unit),/invalid_spin_rng_result/);
  f.figure.skills=[attack(1199,1,96,50)];f.match.phase='started';f.match.turn='black';f.match.positions.set(0,21);
  f.match.record.players[0].plates=[5002];f.match.plateState=null;
  f.service.acceptPlayerMove(f.match,{selective_side:'black',value:{type:'declare_plate',plate_id:5002,value:{type:'put_circle',condition:'normal',pokemons:[0]}}},'black');
  assert.equal(f.match.conditions.get(0),'normal');assert.equal(rules.rollBattleWheel(f.match,0,()=>0).results[0].displace,0);
  f.match.phase='finished';
});

async function until(predicate,label) {for(let i=0;i<250;i++){if(predicate())return;await delay(5);}assert.fail(label);}
async function setup(owner,mode) {
  const enemy=owner===0?6:0,side=owner===0?'black':'white';
  const queues=new Map([[owner,mode==='respin'?[32,64,64,0,0,32]:[0,64,0]],[enemy,[0,48]]]);
  const outcomes=[],rejected=[];let secondary=null;
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:(_,pokemon)=>queues.get(pokemon).shift()});
  service.playOpponentTurn=()=>{};service.declareOpponentRespin=()=>{};service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  if(mode==='secondary')service.scheduleSecondarySpins=(_,pending)=>{secondary=pending;};
  const original=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const outcome=original(...args);outcomes.push(structuredClone(outcome));return outcome;};
  const match=service.createMatch('panic-accepted-two-battles');match.record=structuredClone(primary.record);match.record.all_moves=[];match.plateState=null;
  match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const player of match.record.players) {
    if(player.color===side)player.plates=[5015,...player.plates.filter(id=>id!==5015).slice(0,5)];
    for(const p of player.pokemons) {
      p.pokepower=-1;
      if(p.pokemon_index===owner)p.skills=mode==='respin'?[attack(1131,0,32),attack(1168,1,32,30),attack(1003,3,32,100)]
        :[attack(1199,1,32,50),attack(1122,4,32),attack(1131,0,32)];
      if(p.pokemon_index===enemy)p.skills=[attack(1009,2,48,2),attack(mode==='secondary'?1001:1199,1,48,mode==='secondary'?100:50)];
    }
  }
  const actions=structuredClone(primary.record.all_moves.slice(0,-1));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejected,[]);};
  try {
    for(const action of actions)accept(action);
    await until(()=>outcomes.length===1&&!match.battleResolutionPending,'first Confuse Ray');
    assert.equal(match.conditions.get(owner),'panic');
    if(mode==='respin')accept({selective_side:side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
    accept({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
    if(mode==='respin') {
      await until(()=>!!match.pendingRespin,'panic Double Chance preview');
      accept({selective_side:side,value:{type:'declare_respin',pokemons:[owner]}});
      await until(()=>outcomes.length===2&&!match.battleResolutionPending,'panic shifted repeated-hit respin');
    } else await until(()=>!!secondary,'pending Ice Shard secondary spin');
    return {service,match,outcomes,queues,enemy,secondary};
  } catch(error) {match.phase='finished';throw error;}
}
for(const owner of [0,6]) test(`panic owner ${owner}: accepted Double Chance replaces Miss with a real shifted repeated-hit sequence`,async()=>{
  const f=await setup(owner,'respin');
  try {
    const spins=f.match.record.all_moves.filter(m=>m.value.type==='spin').map(m=>m.value);
    assert.equal(spins.length,3);
    const initial=spins[0].spins.find(s=>s.pokemon===owner);assert(initial.results.every(r=>r.displace===0),'new panic cannot change its applying battle');
    const preview=spins[1].spins.find(s=>s.pokemon===owner);assert.deepEqual(preview.results,[{num:64,displace:1,type:'battle'}]);
    assert.deepEqual(spins[2].spins,[{pokemon:owner,results:[{num:0,displace:1,type:'battle'},{num:0,displace:1,type:'probability'},{num:32,displace:1,type:'probability'}]}]);
    assert.equal(f.outcomes[1].attackerSkill.id,1168);assert.equal(f.outcomes[1].attackerSkill.speed_or_damage,60);
    assert.equal(f.match.positions.get(f.enemy),f.enemy===0?41:43);assert.equal(f.match.conditions.get(owner),'panic');
    assert([...f.queues.values()].every(q=>q.length===0));
  } finally {f.match.phase='finished';}
});
for(const owner of [0,6]) test(`panic owner ${owner}: deferred faint keeps the original condition for an Ice Shard secondary spin`,async()=>{
  const f=await setup(owner,'secondary');
  try {
    assert.equal(f.match.conditions.get(owner),'faint');assert.equal(f.secondary.outcome.conditionsBefore[owner],'panic');
    assert.equal(f.service.performSecondarySpins(f.match,f.secondary),true);
    await until(()=>!f.match.battleResolutionPending,'finish secondary and KO');
    const spin=f.match.record.all_moves.filter(m=>m.value.type==='spin').at(-1).value.spins;
    assert.deepEqual(spin,[{pokemon:owner,results:[{num:0,displace:1,type:'probability'}]}]);
    assert.equal(rules.selectedSkill(f.match,owner,0,1).id,1122,'shifted secondary selection is Blue');
    assert.equal(f.match.positions.get(owner),owner===0?41:43);assert.equal(f.match.conditions.get(owner),'normal');
    assert([...f.queues.values()].every(q=>q.length===0));
  } finally {f.match.phase='finished';}
});
