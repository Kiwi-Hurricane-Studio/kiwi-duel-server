import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract as contract} from './custom-match-engine.mjs';
import {purpleEffectKnockoutPlan as plan} from './effect-knockouts.mjs';
const read=file=>JSON.parse(readFileSync(new URL(file,import.meta.url),'utf8').replace(/^\uFEFF/,''));
const rules=read('../data/effect_knockout_rules.json'),coverage=read('../docs/generated/mechanics-20260913/coverage.json');
const bindings={1143:1222,1276:1349,1381:1451,1427:1548,1428:1586,1429:1620,1476:1605};
const attack=(id,color=2,power=3,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,id){
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('conditional-effect-KO'),enemy=owner===0?6:0;
  const figure=p=>match.record.players.flatMap(p=>p.pokemons).find(f=>f.pokemon_index===p);
  for(const p of match.record.players)for(const f of p.pokemons){f.id=1002;f.pokepower=-1;f.skills=[attack(1199,1,50)];}
  figure(owner).skills=[attack(id,2,id===1487?2:3)];match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,enemy===0?15:11);match.turn=owner===0?'black':'white';
  return {service,match,owner,enemy,figure};
}
function protect(f,ability){const rule=rules.protections.find(r=>r.ability===ability),holder=rule.target==='self'?f.enemy:f.enemy+1;
  f.figure(holder).id=bindings[ability];f.figure(holder).pokepower=ability;if(holder!==f.enemy)f.match.positions.set(holder,f.enemy===0?20:6);
  if(rule.target_type!==undefined)f.figure(f.enemy).id=rule.target_type===2?1022:1342;
  if(rule.emitter_type!==undefined)f.figure(f.owner).id=1008;
  if(rule.owner_turn_only)f.match.turn=f.enemy===0?'black':'white';return rule;
}
test('conditional Purple rules bind all three original variants and typed original Wait consumer',()=>{
  assert.deepEqual(rules.conditional_purple_attacks.map(r=>r.skill),[1487,1544]);
  assert.equal(coverage.entries.filter(e=>['skill:1487','skill:1544'].includes(e.key)).reduce((n,e)=>n+e.variants.length,0),3);
  const schema=read('../docs/generated/mechanics-20260913/conditional-knockout-wait-consumers.json');assert.equal(schema.original_code_executed,false);
  const method=schema.methods.find(m=>m.token==='[Method:0x27b4]');assert(method.instructions.some(i=>i.includes('castclass')&&i.includes('AiAction/TargetsAnother')));assert(method.instructions.some(i=>i.includes('get_duration()')));assert(method.instructions.some(i=>i.includes('MatchMain::PutAnotherInit')));
});
for(const id of [1487,1544])for(const owner of [0,6])test(`${owner}: ${id} every original variant uses pre-result condition/Wait in both battle roles`,()=>{
  for(const v of coverage.entries.find(e=>e.key==='skill:'+id).variants)for(const defending of [false,true])for(const condition of ['normal',...rules.special_conditions])for(const wait of [0,1,2]){
    const f=fixture(owner,id);f.figure(owner).id=v.occurrences[0].figure_id;f.figure(owner).skills=[attack(id,2,v.stars,v.range),attack(1131,0,0,96-v.range)];
    f.match.conditions.set(f.enemy,condition);f.match.waits.set(f.enemy,wait);f.match.turn=(defending?f.enemy:owner)===0?'black':'white';
    const points=new Map(f.match.positions),r=f.service.applyBaseBattleOutcome(f.match,defending?f.enemy:owner,defending?owner:f.enemy,0,0),eligible=condition!=='normal'||id===1544&&wait>0;
    assert.equal(r.winner,owner);assert.equal(r.effectKnockoutPlan.eligible,eligible);assert.deepEqual(r.pendingKnockoutTargets??[],eligible?[f.enemy]:[]);
    assert.equal(f.match.waits.get(f.enemy),3,'independent Wait applies on every successful Purple result');assert.equal(f.match.conditions.get(f.enemy),eligible?'faint':condition);assert.deepEqual(f.match.positions,points,'Center is committed by completion');
  }
});
for(const id of [1487,1544])for(const owner of [0,6])test(`${owner}: ${id} loses/ties/disabled do not assign its Wait or effect KO`,()=>{
  for(const color of [2,3,4]){
    const f=fixture(owner,id);f.figure(f.enemy).skills=[attack(color===2?1009:color===4?1122:1199,color,color===2?5:color===4?0:50)];f.match.waits.set(f.enemy,1);f.match.conditions.set(f.enemy,'poison');
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert(!result.effectKnockoutPlan);assert.equal(f.match.waits.get(f.enemy),1);assert.deepEqual(result.pendingKnockoutTargets??[],[]);
  }
  const tied=fixture(owner,id);tied.figure(tied.enemy).skills=[attack(1009,2,id===1487?2:3)];assert.equal(tied.service.applyBaseBattleOutcome(tied.match,owner,tied.enemy,0,0).winner,-1);assert.equal(tied.match.waits.get(tied.enemy),0);
  const disabled=fixture(owner,id);disabled.match.disabledSkills.set(owner,new Set([id]));assert(!disabled.service.applyBaseBattleOutcome(disabled.match,owner,disabled.enemy,0,0).effectKnockoutPlan);assert.equal(disabled.match.waits.get(disabled.enemy),0);
});
for(const id of [1487,1544])for(const owner of [0,6])for(const ability of Object.keys(bindings).map(Number))test(`${owner}: ${id} protection ${ability} only prevents KO and retains independent Wait`,()=>{
  for(const condition of ['normal','panic']){
    const f=fixture(owner,id),rule=protect(f,ability);f.match.conditions.set(f.enemy,condition);f.match.waits.set(f.enemy,2);
    const r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0),eligible=condition==='panic'||id===1544,prevented=!rule.healthy_target||condition==='normal';
    assert.deepEqual(r.pendingKnockoutTargets??[],eligible&&!prevented?[f.enemy]:[]);assert.equal(f.match.waits.get(f.enemy),3);
    assert.equal(f.match.conditions.get(f.enemy),eligible&&!prevented?'faint':condition,'preexisting special condition is not cured by failed KO');
  }
});
for(const id of [1487,1544])for(const owner of [0,6])test(`${owner}: ${id} predicate checks target condition, not source, other markers, or freshly assigned Wait`,()=>{
  const f=fixture(owner,id),side=f.match.turn;
  for(const condition of ['normal','faint','curse','wait','final_song']){
    f.match.conditions.set(owner,'poison');f.match.conditions.set(f.enemy,condition);
    const result=plan(f.match.record,f.match.positions,f.match.conditions,owner,f.enemy,attack(id),attack(1199,1,50),side,contract.fieldEdges,f.match.waits);
    assert.equal(result.eligible,false);assert.equal(f.match.waits.get(f.enemy),0,'planning is pure');assert.deepEqual(result.wait_targets,[f.enemy]);
  }
  f.match.conditions.set(owner,'normal');f.match.conditions.set(f.enemy,'normal');const first=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
  assert.equal(first.effectKnockoutPlan.eligible,false);assert.equal(f.match.waits.get(f.enemy),3);assert.equal(f.match.conditions.get(f.enemy),'normal');
  const later=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(later.effectKnockoutPlan.eligible,id===1544,'a later distinct battle can use its existing Wait');
});
for(const id of [1487,1544])for(const owner of [0,6])test(`${owner}: ${id} invalid Center disposition cannot partially set Wait or Faint`,()=>{
  const f=fixture(owner,id),enemy=f.enemy;f.match.conditions.set(enemy,'poison');f.match.waits.set(enemy,1);
  f.match.positions.set(enemy+1,enemy===0?41:43);f.match.positions.set(enemy+2,enemy===0?40:42);f.match.positions.set(enemy+3,30+enemy);
  const points=new Map(f.match.positions),conditions=new Map(f.match.conditions),waits=new Map(f.match.waits);
  assert.throws(()=>f.service.applyBaseBattleOutcome(f.match,owner,enemy,0,0),/invalid_effect_knockout_disposition/);assert.deepEqual(f.match.positions,points);assert.deepEqual(f.match.conditions,conditions);assert.deepEqual(f.match.waits,waits);
  f.match.positions.set(enemy,28+enemy);assert.equal(plan(f.match.record,f.match.positions,f.match.conditions,owner,enemy,attack(id),attack(1199,1,50),f.match.turn,contract.fieldEdges,f.match.waits),null,'off-field target does not receive a battle effect');
});
