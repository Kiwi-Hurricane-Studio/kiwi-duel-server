import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';
const cases=[['burn',10,1023],['poison',20,1073],['bad_poison',40,1075]];
const attack=(id,color,power,range=96)=>({id,color,range,speed_or_damage:power});
const originals=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases;
function isolated(owner,condition,own,opposing) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('condition-damage-isolated');
  const enemy=owner===0?6:0;
  match.conditions.set(owner,condition);match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,enemy===0?15:11);
  for(const p of match.record.players.flatMap(player=>player.pokemons)) {
    p.pokepower=-1;if(p.pokemon_index===owner)p.skills=structuredClone(own);if(p.pokemon_index===enemy)p.skills=structuredClone(opposing);
  }
  return {service,match,enemy};
}

test('original condition descriptions specify fixed10/20/40 damage reductions',()=>{
  const rows=JSON.parse(fs.readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
  for(const [condition,penalty] of cases) assert.match(rows.find(r=>r.text_key===`ConditionMaster.ConditionDescription.${condition}`).text,new RegExp(`\\b${penalty}\\b`));
});
for(const [condition,penalty] of cases) test(`${condition}: both identities and White/Gold use reduced damage before win/draw/loss comparisons, with an explicitly derived zero floor`,()=>{
  for(const owner of [0,6]) for(const color of [1,3]) for(const power of [0,9,10,11,19,20,21,39,40,41,100]) {
    const expected=Math.max(0,power-penalty);
    const {service,match,enemy}=isolated(owner,condition,[attack(color===1?1199:1003,color,power)],[attack(1370,1,expected)]);
    const result=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal(result.attackerSkill.speed_or_damage,expected);assert.equal(result.winner,-1);assert.equal(result.knockout,false);
    assert.equal(match.conditions.get(owner),condition);
  }
});

test('damage conditions do not alter Purple stars, Blue, Miss, or wheel definitions',()=>{
  for(const [condition] of cases) for(const color of [0,2,4]) {
    const authored=attack(color===0?1131:color===2?1009:1122,color,color===2?2:0);
    const {match}=isolated(0,condition,[authored],[attack(1199,1,50)]);
    const before=JSON.stringify(match.record.players),selected=rules.selectedSkill(match,0,0);
    rules.applyConditionBattleDamage(match,0,6,selected);
    assert.deepEqual(selected,authored);assert.equal(JSON.stringify(match.record.players),before);
  }
});

test('burn uses total Attack size, disables every split piece, and chooses exactly one tied Attack',()=>{
  const {match}=isolated(0,'burn',[attack(1199,1,50,48),attack(1122,4,0,8),attack(1003,3,40,16),attack(1009,2,2,16),attack(1122,4,0,8)],[attack(1199,1,50)]);
  for(const choice of [0,1,2]) {
    let calls=0;
    assert.deepEqual(rules.conditionDisabledSkills(match,0,(maximum,pokemon)=>{calls++;assert.equal(maximum,3);assert.equal(pokemon,0);return choice;}),[[1122,1003,1009][choice]]);
    assert.equal(calls,1);
  }
  assert.throws(()=>rules.conditionDisabledSkills(match,0,()=>3),/invalid_condition_choice_rng_result/);
  match.disabledSkills.set(0,new Set([1122]));
  for(const unit of [48,88]) {
    const selected=rules.selectedSkill(match,0,unit);rules.applyConditionBattleDamage(match,0,6,selected);
    assert.equal(selected.id,1131);assert.equal(selected.speed_or_damage,0);assert.equal(selected.paralysis_replacement,false);
  }
});

for(const [condition,penalty] of cases) test(`${condition}: repeated/single-retry damage accumulates first and the reduction is applied once after X Attack`,()=>{
  for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676]) {
    const {match}=isolated(0,condition,[attack(id,1,50,48),attack(1131,0,0,48)],[attack(1199,1,100)]);
    match.damageBonuses.set(0,30);
    const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id);
    const units=repeat?[0,0,0,48]:[0,0];
    const selected=rules.selectedSpinSkill(match,0,units.map((num,index)=>({num,displace:0,type:index?'probability':'battle'})));
    const gross=repeat?150:id===1301?70:100;
    assert.equal(selected.speed_or_damage,gross+30);
    rules.applyConditionBattleDamage(match,0,6,selected);
    assert.equal(selected.speed_or_damage,gross+30-penalty);
    assert.deepEqual(selected.condition_damage,{condition,current:gross+30,addend:-penalty,result:gross+30-penalty});
  }
});

for(const owner of [0,6]) test(`1621 owner ${owner}: paralysis doubles before comparison regardless of the opponent's selected color`,()=>{
  for(const color of [0,1,2,3,4]) {
    const {service,match,enemy}=isolated(owner,'normal',[attack(1621,1,50)],[attack(color===0?1131:color===2?1009:color===4?1122:1199,color,color===2?2:75)]);
    match.conditions.set(enemy,'paralyze');
    const result=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal(result.attackerSkill.speed_or_damage,100);
    assert.equal(result.winner,[0,1,3].includes(color)?owner:enemy);
    assert.equal(result.knockout,[0,1,3].includes(color));
  }
  const f=isolated(owner,'poison',[attack(1621,1,50)],[attack(1199,1,110)]);
  f.match.conditions.set(f.enemy,'paralyze');f.match.damageBonuses.set(owner,30);
  const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
  assert.equal(result.attackerSkill.speed_or_damage,110,'50*2 +30 -20');assert.equal(result.winner,-1);
});

async function until(predicate,label) {for(let i=0;i<240;i++){if(predicate())return;await delay(5);}assert.fail(label);}
async function accepted(owner,condition,id,power,color) {
  const source=originals.find(c=>c.name.endsWith(`purple-primary-${id}`)),enemy=owner===0?6:0;
  const queues=new Map([[owner,[0,color===1?0:48]],[enemy,[0,48]]]),rejected=[],outcomes=[];
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,
    conditionChoiceSource:()=>assert.fail('unique Blue minimum consumes no choice RNG'),spinUnitSource:(_,pokemon)=>queues.get(pokemon).shift()});
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  const original=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const result=original(...args);outcomes.push(structuredClone(result));return result;};
  const match=service.createMatch('accepted-condition-two-battles');match.record=structuredClone(source.record);match.record.all_moves=[];
  match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const p of match.record.players.flatMap(player=>player.pokemons)) {
    p.pokepower=-1;
    if(p.pokemon_index===owner)p.skills=[attack(1199,1,power,48),attack(1003,3,power,32),attack(1122,4,0,16)];
    if(p.pokemon_index===enemy)p.skills=[attack(id,2,2,48),attack(1370,1,40,48)];
  }
  const actions=structuredClone(source.record.all_moves.slice(0,-1));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejected,[]);};
  try {
    for(const action of actions)accept(action);
    await until(()=>outcomes.length===1&&!match.battleResolutionPending,'primary condition application');
    assert.equal(match.conditions.get(owner),condition);assert.equal(outcomes[0].defenderSkill.speed_or_damage,power,'new condition does not retroactively change its applying battle');
    accept({selective_side:owner===0?'black':'white',value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
    await until(()=>outcomes.length===2&&!match.battleResolutionPending,'condition-modified second battle');
    return {match,outcomes,enemy};
  } catch(error) {match.phase='finished';throw error;}
}
for(const [condition,penalty,id] of cases) for(const owner of [0,6]) for(const color of [1,3]) for(const delta of [-1,0,1]) test(`${condition} owner ${owner}, color ${color}, comparison ${delta}: accepted two-battle damage and destination`,async()=>{
  const f=await accepted(owner,condition,id,40+penalty+delta,color);
  try {
    const second=f.outcomes[1];assert.equal(second.attackerSkill.speed_or_damage,40+delta);
    assert.equal(second.winner,delta<0?f.enemy:delta>0?owner:-1);assert.equal(second.knockout,delta!==0);
    const loser=delta<0?owner:f.enemy;
    if(delta!==0)assert.equal(f.match.positions.get(loser),loser===0?41:43);
    const disables=f.match.record.all_moves.filter(m=>m.value.type==='disable_skill');
    assert.deepEqual(disables.map(m=>m.value),condition==='burn'?[{pokemon:owner,skill_id:[1122],type:'disable_skill'}]:[]);
    assert.equal(f.match.disabledSkills.size,0);
  } finally {f.match.phase='finished';}
});
