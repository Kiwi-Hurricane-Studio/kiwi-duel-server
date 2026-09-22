import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';

const attack=(id,color,range=16)=>({id,color,range,speed_or_damage:color===2?1:[1,3].includes(color)?50:0});
const wheel=()=>[attack(1199,1),attack(1003,3),attack(1009,2),attack(1122,4),attack(1122,4),attack(1131,0)];
const disabled=[1199,1003,1009,1122];
const primary=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases.find(c=>c.name.endsWith('purple-primary-1319'));
async function until(predicate,label) {for(let i=0;i<240;i++){if(predicate())return;await delay(5);}assert.fail(label);}

test('original freeze and melt descriptions both specify all Attacks miss',()=>{
  const rows=JSON.parse(fs.readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
  for(const condition of ['freeze','melt']) assert.match(rows.find(row=>row.text_key===`ConditionMaster.ConditionDescription.${condition}`).text,/In battle, all Attacks will miss\./);
});

for(const condition of ['freeze','melt']) test(`${condition}: every catalog wheel disables all positive non-Miss Attacks without a random choice`,()=>{
  const service=new CustomMatchService({port:0}),match=service.createMatch(`all-wheel-${condition}`);
  const target=match.record.players[0].pokemons[0];match.conditions.set(0,condition);
  const figures=JSON.parse(fs.readFileSync(new URL('../data/figure_battle_master_map.json',import.meta.url))).figures;
  for(const figure of Object.values(figures)) {
    target.skills=figure.skills.map(s=>attack(s.skill_master_id,s.color,s.range));
    const ids=rules.conditionDisabledSkills(match,0,()=>assert.fail('all-Attacks replacement used choice RNG'));
    assert.equal(ids.length,new Set(ids).size,'one ID for all its split segments');
    match.disabledSkills.set(0,new Set(ids));
    let offset=0;
    for(const segment of target.skills) {
      if(segment.range>0) {
        const result=rules.selectedSkill(match,0,offset);
        assert.equal(result.color,0,`figure ${figure.item_master_id} segment ${segment.id}`);
        if(segment.color>0) {assert.equal(result.id,1131);assert.equal(result.speed_or_damage,0);assert.equal(result.paralysis_replacement,false);}
      }
      offset+=Math.max(0,segment.range);
    }
  }
  target.skills=[attack(1131,0,96),attack(1122,4,0)];
  assert.deepEqual(rules.conditionDisabledSkills(match,0),[]);
});

for(const condition of ['freeze','melt']) for(const owner of [0,6]) test(`${condition}, owner ${owner}: selected Miss has no paralysis-only bonus and Full Heal restores the whole wheel`,()=>{
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('frozen-wheel-isolated-state');
  const enemy=owner===0?6:0,side=owner===0?'black':'white';
  match.phase='started';match.turn=side;match.positions.set(owner,owner===0?21:6);match.positions.set(enemy,owner===0?17:10);
  for(const p of match.record.players.flatMap(player=>player.pokemons)) {
    p.pokepower=-1;if(p.pokemon_index===owner)p.skills=wheel();if(p.pokemon_index===enemy)p.skills=[attack(1621,1,96)];
  }
  match.conditions.set(owner,condition);match.damageBonuses.set(owner,30);
  match.disabledSkills.set(owner,new Set(rules.conditionDisabledSkills(match,owner)));
  for(const unit of [0,16,32,48,64,80]) {
    const selected=rules.selectedSkill(match,owner,unit);
    assert.equal(selected.color,0);assert.equal(Number(selected.speed_or_damage),0);
    assert.notEqual(selected.paralysis_replacement,true);
  }
  // Use a disposable outcome projection because the real damage KO clears
  // the condition. This assertion tests the existing 1621 native subset.
  const outcome=service.applyBaseBattleOutcome(match,enemy,owner,0,0);
  assert.equal(outcome.attackerSkill.speed_or_damage,50,'freeze/melt never impersonates paralysis');
  match.conditions.set(owner,condition);match.positions.set(owner,owner===0?21:6);match.disabledSkills.clear();
  match.record.players[owner===0?0:1].plates=[5002];match.plateState=null;
  service.acceptPlayerMove(match,{selective_side:side,value:{type:'declare_plate',plate_id:5002,value:{type:'put_circle',condition:'normal',pokemons:[owner]}}},side);
  assert.equal(match.conditions.get(owner),'normal');assert.deepEqual(rules.conditionDisabledSkills(match,owner),[]);
  assert.equal(rules.selectedSkill(match,owner,0).id,1199);assert.equal(rules.selectedSkill(match,owner,48).id,1122);
  match.phase='finished';
});

async function setup(owner,unit,respin) {
  const enemy=owner===0?6:0,enemySide=enemy===0?'black':'white';
  const queues=new Map([[owner,[0,unit]],[enemy,respin?[0,32,64]:[0,64]]]),rejected=[],outcomes=[];
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,
    conditionChoiceSource:()=>assert.fail('freeze does not choose one Attack'),spinUnitSource:(_,pokemon)=>queues.get(pokemon).shift()});
  service.playOpponentTurn=()=>{};service.declareOpponentRespin=()=>{};service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  const original=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const result=original(...args);outcomes.push(structuredClone(result));return result;};
  const match=service.createMatch('freeze-accepted-two-battles');match.record=structuredClone(primary.record);
  match.record.all_moves=[];match.plateState=null;match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const player of match.record.players) {
    if(player.color===enemySide)player.plates=[5015,...player.plates.filter(id=>id!==5015).slice(0,5)];
    for(const p of player.pokemons) {
      p.pokepower=-1;if(p.pokemon_index===owner)p.skills=wheel();
      if(p.pokemon_index===enemy)p.skills=[attack(1319,2,32),attack(1122,4,32),attack(1621,1,32)];
    }
  }
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejected,[]);};
  const actions=structuredClone(primary.record.all_moves.slice(0,-1));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  try {
    for(const action of actions)accept(action);
    await until(()=>outcomes.length===1&&!match.battleResolutionPending,'first Diamond Dust battle');
    assert.equal(match.conditions.get(owner),'freeze');
    accept({selective_side:owner===0?'black':'white',value:{type:'mp_move',route:owner===0?[29,21]:[35,0]}});
    if(respin)accept({selective_side:enemySide,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:enemy}}});
    accept({selective_side:enemySide,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}});
    if(respin) {
      await until(()=>!!match.pendingRespin,'frozen opponent Double Chance preview');
      assert.deepEqual([...match.disabledSkills.get(owner)],disabled);
      accept({selective_side:enemySide,value:{type:'declare_respin',pokemons:[enemy]}});
    }
    await until(()=>outcomes.length===2&&!match.battleResolutionPending,'second battle completes');
    return {match,outcomes};
  } catch(error) {match.phase='finished';throw error;}
}

for(const owner of [0,6]) for(const unit of [0,16,32,48,64,80]) test(`freeze owner ${owner}, unit ${unit}: accepted application then incoming battle replaces every Attack`,async()=>{
  const f=await setup(owner,unit,false);
  try {
    const disables=f.match.record.all_moves.filter(move=>move.value.type==='disable_skill');
    assert.deepEqual(disables.map(move=>move.value),[{pokemon:owner,skill_id:disabled,type:'disable_skill'}]);
    assert.equal(f.outcomes[1].defenderSkill.id,1131);assert.equal(f.outcomes[1].defenderSkill.color,0);
    assert.equal(f.outcomes[1].attackerSkill.speed_or_damage,50);assert.equal(f.outcomes[1].knockout,true);
    assert.equal(f.match.positions.get(owner),owner===0?41:43);assert.equal(f.match.disabledSkills.size,0);
    const types=f.match.record.all_moves.map(move=>move.value.type),i=types.indexOf('disable_skill');
    assert.equal(types[i-1],'declare_battle');assert.equal(types[i+1],'spin');
  } finally {f.match.phase='finished';}
});

for(const owner of [0,6]) test(`freeze owner ${owner}: all-Attack replacement survives the opponent's Double Chance respin`,async()=>{
  const f=await setup(owner,64,true);
  try {
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='disable_skill').length,1);
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='spin').length,3);
    assert.equal(f.outcomes[1].defenderSkill.id,1131);assert.equal(f.outcomes[1].attackerSkill.speed_or_damage,50);
    assert.equal(f.outcomes[1].knockout,true);assert.equal(f.match.disabledSkills.size,0);
  } finally {f.match.phase='finished';}
});
