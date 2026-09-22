import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';
const skill=(id,color,range)=>({id,color,range,speed_or_damage:color===2?1:50});

test('paralysis groups split Attack pieces and excludes Miss and zero-size pieces',()=>{
  const figure={skills:[skill(1131,0,4),skill(1199,1,28),skill(1122,4,16),skill(1009,2,28),skill(1122,4,12),skill(1003,3,0)]};
  assert.deepEqual(rules.smallestAttackIds(figure),[1199,1122,1009]);
  figure.skills[1].range=20;
  assert.deepEqual(rules.smallestAttackIds(figure),[1199]);
  assert.deepEqual(rules.smallestAttackIds({skills:[skill(1131,0,96),skill(1122,4,0)]}),[]);
});

test('all original figure wheels map to the smallest total non-Miss Attack size',()=>{
  const figures=JSON.parse(fs.readFileSync(new URL('../data/figure_battle_master_map.json',import.meta.url))).figures;
  for(const figure of Object.values(figures)) {
    const skills=figure.skills.map(s=>skill(s.skill_master_id,s.color,s.range));
    const eligible=skills.filter(s=>s.color>0&&s.range>0);
    const ids=[...new Set(eligible.map(s=>s.id))];
    const sums=ids.map(id=>eligible.filter(s=>s.id===id).reduce((sum,s)=>sum+s.range,0));
    const expected=ids.filter((_,index)=>sums[index]===Math.min(...sums));
    assert.deepEqual(rules.smallestAttackIds({skills}),expected,`figure ${figure.item_master_id}`);
  }
});

test('every native six-figure selection belongs to the recovered minimum set',()=>{
  const root=new URL('../docs/generated/battle-route-20260906/custom-engine-authority/',import.meta.url);
  for(let index=0;index<6;index++) {
    const record=JSON.parse(fs.readFileSync(new URL(`controlled-records/paralyze-black-wheel-${index}-before-disable.json`,root))).record;
    const response=JSON.parse(fs.readFileSync(new URL(`paralyze-black-wheel-${index}-before-disable-legal_moves.json`,root)));
    assert.equal(response.legal_moves.length,1);
    const move=response.legal_moves[0];assert.equal(move.value.type,'disable_skill');assert.equal(move.selective_side,'both');
    const figure=record.players.flatMap(player=>player.pokemons).find(p=>p.pokemon_index===move.value.pokemon);
    assert(rules.smallestAttackIds(figure).includes(move.value.skill_id[0]),`native wheel ${index}`);
  }
});

test('seeded tied choices exercise each minimum without selecting larger or missed attacks',()=>{
  const service=new CustomMatchService({port:0}),match=service.createMatch('paralysis-seeded');
  const figure=match.record.players[0].pokemons[0];
  figure.skills=[skill(1199,1,48),skill(1122,4,16),skill(1003,3,16),skill(1009,2,16)];
  match.conditions.set(0,'paralyze');
  let state=0x12345678;const counts=new Map([[1122,0],[1003,0],[1009,0]]);
  const choose=maximum=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor((state/2**32)*maximum);};
  for(let index=0;index<6000;index++) {const id=rules.paralysisDisabledSkill(match,0,choose);assert(counts.has(id));counts.set(id,counts.get(id)+1);}
  for(const count of counts.values()) assert(count>1800&&count<2200,'seeded distribution, not native seed parity');
  for(const invalid of [-1,3,NaN,Infinity,0.5,undefined]) assert.throws(()=>rules.paralysisDisabledSkill(match,0,()=>invalid),/invalid_condition_choice_rng_result/);
  match.conditions.set(0,'normal');assert.equal(rules.paralysisDisabledSkill(match,0,()=>assert.fail('normal condition consumed RNG')),-1);
  match.conditions.set(0,'paralyze');figure.skills=[skill(1122,4,96)];
  assert.equal(rules.paralysisDisabledSkill(match,0,()=>assert.fail('unique smallest Attack consumed RNG')),1122);
  figure.skills=[skill(1131,0,96)];assert.equal(rules.paralysisDisabledSkill(match,0,()=>assert.fail('all-Miss wheel consumed RNG')),-1);
});

const source=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases.find(c=>c.name.endsWith('purple-primary-1045'));
async function until(predicate,message) {for(let i=0;i<200;i++){if(predicate())return;await delay(5);}assert.fail(message);}
async function setup(owner,choiceSource,secondUnit=48) {
  const queues=new Map([[owner,[0,secondUnit,64]],[owner===0?6:0,[0,0]]]),rejected=[],writes=[],outcomes=[];
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,
    conditionChoiceSource:choiceSource,spinUnitSource:(_,pokemon)=>queues.get(pokemon).shift()});
  service.playOpponentTurn=()=>{};service.declareOpponentRespin=()=>{};
  service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  const original=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const result=original(...args);outcomes.push(structuredClone(result));return result;};
  const match=service.createMatch('paralysis-accepted-actions');
  match.record=structuredClone(source.record);match.record.all_moves=[];match.plateState=null;match.phase='started';
  const ownerPlayer=match.record.players.find(player=>player.color===(owner===0?'black':'white'));
  if(!ownerPlayer.plates.includes(5015)) ownerPlayer.plates=[5015,...ownerPlayer.plates.slice(1)];
  match.socket={destroyed:false,write:value=>writes.push(value)};
  for(const figure of match.record.players.flatMap(player=>player.pokemons)) {
    figure.pokepower=-1;
    if(figure.pokemon_index===owner) figure.skills=[skill(1199,1,48),skill(1122,4,16),skill(1003,3,16),skill(1009,2,16)];
    else if([0,6].includes(figure.pokemon_index)) figure.skills=[{id:1045,color:2,range:96,speed_or_damage:2}];
  }
  const prefix=structuredClone(source.record.all_moves.slice(0,-1));
  if(owner===6) prefix.splice(prefix.length-1,1,{selective_side:'white',value:{type:'null_move'}},
    {selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  const accept=action=>{service.acceptPlayerMove(match,structuredClone(action),action.selective_side);assert.deepEqual(rejected,[]);};
  try {
    for(const action of prefix)accept(action);
    await until(()=>outcomes.length===1&&!match.battleResolutionPending,'first condition-applying battle');
    assert.equal(match.conditions.get(owner),'paralyze');assert.equal(match.turn,owner===0?'black':'white');
    return {service,match,accept,writes,outcomes,side:match.turn};
  } catch(error) {match.phase='finished';throw error;}
}
for(const owner of [0,6]) for(const choice of [0,1,2]) test(`paralysis owner ${owner}, tied choice ${choice}: accepted battle records and applies exactly one disabled Attack`,async()=>{
  let calls=0;const f=await setup(owner,(maximum,pokemon)=>{calls++;assert.equal(maximum,3);assert.equal(pokemon,owner);return choice;},48+choice*16);
  try {
    f.accept({selective_side:f.side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:owner===0?6:0}});
    await until(()=>f.outcomes.length===2&&!f.match.battleResolutionPending,'second paralysis battle');
    const disables=f.match.record.all_moves.filter(move=>move.value.type==='disable_skill');
    assert.deepEqual(disables.map(move=>move.value),[{pokemon:owner,skill_id:[[1122,1003,1009][choice]],type:'disable_skill'}]);
    assert.equal(f.outcomes[1].attackerSkill.id,1131);assert.equal(f.outcomes[1].attackerSkill.color,0);
    assert.equal(calls,1);assert.equal(f.match.disabledSkills.size,0,'battle-local disable expires');
    const types=f.match.record.all_moves.map(move=>move.value.type),index=types.indexOf('disable_skill');
    assert.equal(types[index-1],'declare_battle');assert.equal(types[index+1],'spin');
    assert(f.writes.some(line=>line.includes('disable_skill')));
  } finally {f.match.phase='finished';}
});

for(const owner of [0,6]) test(`paralysis owner ${owner}: Double Chance retains the chosen disabled Attack for the entire respin transaction`,async()=>{
  let calls=0;const f=await setup(owner,()=>{calls++;return 0;});
  try {
    f.accept({selective_side:f.side,value:{type:'declare_plate',plate_id:5015,value:{type:'select_pokemon',pokemon:owner}}});
    f.accept({selective_side:f.side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:owner===0?6:0}});
    await until(()=>!!f.match.pendingRespin,'Double Chance preview');
    assert.equal(calls,1);assert.deepEqual([...f.match.disabledSkills.get(owner)],[1122]);
    f.accept({selective_side:f.side,value:{type:'declare_respin',pokemons:[owner]}});
    await until(()=>f.outcomes.length===2&&!f.match.battleResolutionPending,'Double Chance final outcome');
    assert.equal(calls,1,'respin does not choose another disabled Attack');
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='disable_skill').length,1);
    assert.equal(f.outcomes[1].attackerSkill.id,1003);assert.equal(f.outcomes[1].knockout,true);
    assert.equal(f.match.positions.get(owner===0?6:0),owner===0?43:41);
    assert.equal(f.match.disabledSkills.size,0);
  } finally {f.match.phase='finished';}
});

test('invalid tied-choice RNG rejects before any disable or spin publication and can recover with valid input',async()=>{
  let bad=true;const f=await setup(0,()=>bad?0.5:0);
  try {
    f.accept({selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
    await delay(20);
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='spin').length,1);
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='disable_skill').length,0);
    assert.equal(f.match.disabledSkills.size,0);assert.equal(f.match.activeBattleDeclaration.started,false);
    bad=false;f.service.resolveBattle(f.match,f.match.activeBattleDeclaration.move);
    await until(()=>f.outcomes.length===2&&!f.match.battleResolutionPending,'valid retry after rejected RNG');
    assert.equal(f.match.record.all_moves.filter(move=>move.value.type==='disable_skill').length,1);
  } finally {f.match.phase='finished';}
});
