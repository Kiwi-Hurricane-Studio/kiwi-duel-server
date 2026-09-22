import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchContract,customMatchTestHooks as rules} from './custom-match-engine.mjs';
import {conditionImmunitySources} from './condition-immunity.mjs';
import {resolveRecordFigure,zSkillCatalog} from './z-skill-catalog.mjs';

const selfRules=new Map([[1001,['paralyze']],[1027,['poison','bad_poison','paralyze','burn']],[1048,['paralyze']],
  [1064,['sleep']],[1066,['panic']],[1071,['burn']],[1072,['burn']],[1073,['burn']],[1075,['poison','bad_poison']],
  [1077,['sleep']],[1149,['burn','freeze']],[1153,['freeze','sleep']],
  [1226,['bad_poison','burn','freeze','melt','panic','paralyze','poison']],[1330,['paralyze']],[1338,['paralyze']],[1339,['paralyze']],
  [1484,['bad_poison','burn','freeze','melt','panic','paralyze','poison']]]);
const statuses=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const attacks=new Map([[1009,'panic'],[1063,'panic'],[1070,'panic'],[1018,'sleep'],[1039,'sleep'],[1064,'sleep'],[1085,'sleep'],[1318,'sleep'],[1020,'sleep'],
  [1023,'burn'],[1024,'burn'],[1106,'burn'],[1045,'paralyze'],[1071,'paralyze'],[1103,'paralyze'],[1073,'poison'],[1074,'poison'],[1077,'poison'],[1078,'poison'],[1075,'bad_poison'],[1076,'bad_poison'],[1319,'freeze']]);
const attack=(id=1199,color=1,power=100)=>({id,color,range:96,speed_or_damage:power});
const primary=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/native-multispin.json',import.meta.url))).cases.find(c=>c.name.endsWith('purple-primary-1018'));
function fixture(owner,ability) {
  const service=new CustomMatchService({port:0}),match=service.createMatch('condition-immunity-isolated');
  const figures=match.record.players.flatMap(p=>p.pokemons),target=figures.find(p=>p.pokemon_index===owner),enemy=owner===0?6:0;
  for(const figure of figures){figure.pokepower=-1;figure.skills=[attack()];}
  target.pokepower=ability;match.positions.set(0,15);match.positions.set(6,11);
  return {service,match,figures,target,enemy,enemyFigure:figures.find(p=>p.pokemon_index===enemy)};
}
const sources=(f,owner,condition)=>conditionImmunitySources(f.match.record,f.match.positions,owner,condition,customMatchContract.fieldEdges);

for(const [ability,immune] of selfRules)test(`ability ${ability}: both owners, every primary status variant and unaffected conditions`,()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,ability);
    for(const condition of [...statuses,'normal','faint','curse','wait']) {
      assert.equal(sources(f,owner,condition).length,immune.includes(condition)?1:0,`${ability}:${condition}`);
      assert.deepEqual(sources(f,f.enemy,condition),[],'a self immunity must not protect the opponent');
    }
    for(const [skill,condition] of attacks)for(const prior of ['normal','panic']) {
      f.enemyFigure.skills=[attack(skill,2,2)];f.match.conditions.set(owner,prior);f.match.conditions.set(f.enemy,'normal');
      f.match.waits.set(owner,4);f.match.battledAfterField.clear();
      const outcome=f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
      assert.equal(outcome.winner,f.enemy,'prevention must not reverse the Purple color result');
      assert.equal(f.match.conditions.get(owner),immune.includes(condition)?prior:condition,`${ability}/${skill}/${prior}`);
      assert.equal(f.match.waits.get(owner),4,'a prevented condition does not cure Wait');
      assert.equal(f.match.positions.get(owner),owner===0?15:11,'prevention is not a bench or Center move');
      assert.equal(f.match.conditions.get(f.enemy),skill===1020?'sleep':'normal');
    }
    for(const offField of [28+owner,owner===0?41:43,44]){
      f.match.positions.set(owner,offField);assert.deepEqual(sources(f,owner,immune[0]),[]);
    }
    f.match.phase='finished';
  }
});

for(const [ability,conditions,types] of [[1151,['burn'],[8]],[1383,['burn'],null],[1396,['poison','bad_poison'],[2,10]],[1427,statuses,null],[1485,statuses,null]]) {
  test(`aura ${ability}: type identity, team ownership, field lifetime and adjacency`,()=>{
    for(const owner of [0,6]) {
      const f=fixture(owner,-1),source=f.figures.find(p=>p.pokemon_index===owner+1);
      source.pokepower=ability;
      f.match.positions.set(owner+1,owner===0?20:6);
      for(const original of Object.values(zSkillCatalog().rules).filter(rule=>rule.playable)) {
        f.target.id=original.rule_poke_id;
        const resolved=resolveRecordFigure(f.target.id);assert.equal(resolved.ok,true);
        for(const condition of statuses) {
          const applies=conditions.includes(condition)&&(!types||types.includes(original.type0)||types.includes(original.type1));
          assert.equal(sources(f,owner,condition).length,applies?1:0,`${ability}/${f.target.id}/${condition}`);
        }
      }
      f.target.id=types?Object.values(zSkillCatalog().rules).find(rule=>rule.playable&&(types.includes(rule.type0)||types.includes(rule.type1))).rule_poke_id:1302;
      const condition=conditions[0];
      assert.equal(sources(f,owner,condition).length,1);
      const before=f.match.conditions.get(owner);f.match.conditions.set(owner,'panic');
      assert.equal(sources(f,owner,condition).length,1,'new-application protection does not require an existing condition to be normal');
      assert.equal(f.match.conditions.get(owner),'panic','checking an immunity never cures an old condition');f.match.conditions.set(owner,before);
      f.match.positions.set(owner+1,owner===0?21:0);
      assert.equal(sources(f,owner,condition).length,ability===1485?0:1,'only the adjacent aura depends on distance');
      for(const point of [28+owner+1,owner===0?41:43,44]){f.match.positions.set(owner+1,point);assert.deepEqual(sources(f,owner,condition),[]);}
      f.match.positions.set(owner+1,owner===0?20:6);assert.equal(sources(f,owner,condition).length,1,'field re-entry restores prospective protection');
      assert.deepEqual(sources(f,f.enemy,condition),[],'an aura does not protect the opposing team');
      if(types){f.target.id=999999;assert.deepEqual(sources(f,owner,condition),[],'unknown type identity cannot invent a typed protection');}
      f.match.phase='finished';
    }
  });
}

test('both-sleep targets are filtered independently and Blackout still assigns Wait when paralysis is prevented',()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,1064);f.enemyFigure.skills=[attack(1020,2,2)];
    f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(f.match.conditions.get(owner),'normal');assert.equal(f.match.conditions.get(f.enemy),'sleep');
    f.enemyFigure.pokepower=1077;f.match.conditions.set(f.enemy,'normal');f.match.battledAfterField.clear();
    f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);assert.equal(f.match.conditions.get(f.enemy),'normal');
    f.enemyFigure.pokepower=1326;f.enemyFigure.skills=[attack(1122,4,0)];f.target.pokepower=1001;
    f.match.conditions.set(owner,'burn');f.match.battledAfterField.clear();
    f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(f.match.conditions.get(owner),'burn');assert.equal(f.match.waits.get(owner),3);
    f.match.phase='finished';
  }
});

test('typed protection resolves every original figure alias consistently with its canonical rule',()=>{
  const f=fixture(0,-1),source=f.figures.find(p=>p.pokemon_index===1);source.pokepower=1151;f.match.positions.set(1,20);
  const catalog=zSkillCatalog();let checked=0;
  for(const rule of Object.values(catalog.rules))for(const alias of rule.item_master_ids) {
    f.target.id=alias;
    const conflict=catalog.rules[alias]&&catalog.rules[alias].rule_poke_id!==rule.rule_poke_id;
    const expected=!conflict&&rule.playable&&(rule.type0===8||rule.type1===8);
    assert.equal(sources(f,0,'burn').length,expected?1:0,`alias ${alias} -> rule ${rule.rule_poke_id}`);checked++;
  }
  assert.equal(checked,583);f.match.phase='finished';
});

test('overlapping auras preserve one application decision and do not prevent an ordinary damage KO',()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,-1);f.target.id=1001;
    for(const offset of [1,2]){f.figures.find(p=>p.pokemon_index===owner+offset).pokepower=1427;f.match.positions.set(owner+offset,owner===0?19+offset:offset+4);}
    assert.deepEqual(sources(f,owner,'sleep').map(s=>s.pokemon),[owner+1,owner+2]);
    f.enemyFigure.skills=[attack(1018,2,2)];f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(f.match.conditions.get(owner),'normal');assert.deepEqual(sources(f,owner,'faint'),[]);
    f.enemyFigure.skills=[attack(1199,1,100)];f.target.skills=[attack(1131,0,0)];
    const result=f.service.applyBaseBattleOutcome(f.match,f.enemy,owner,0,0);
    assert.equal(result.knockout,true);assert.equal(f.match.positions.get(owner),owner===0?41:43);
    assert.equal(new Set(f.match.positions.values()).size,12);f.match.phase='finished';
  }
});

test('original descriptions bind every immunity ID and numeric Water/Grass/Poison label',()=>{
  const data=JSON.parse(fs.readFileSync(new URL('../data/condition_immunity_rules.json',import.meta.url)));
  const text=JSON.parse(fs.readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
  assert.equal(data.rules.length,22);assert.equal(new Set(data.rules.map(r=>r.ability)).size,22);
  for(const rule of data.rules)assert(text.some(row=>row.text_key===`FigureMaster.PokepowerDescription.${rule.ability}`&&/cannot/i.test(row.text)),String(rule.ability));
  for(const [id,label]of Object.entries(data.type_labels))assert(text.some(row=>row.text_key===`FigureMaster.TypeName.${id}`&&row.text===label));
});

for(const owner of [0,6])test(`accepted primary Sleep is prevented for owner ${owner} and the target can take its next turn`,async()=>{
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:()=>0});
  service.playOpponentTurn=()=>{};const rejected=[];service.rejectPlayerMove=(_,reason)=>rejected.push(reason);
  const match=service.createMatch('immune-sleep-accepted');match.record=structuredClone(primary.record);match.record.all_moves=[];match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const figure of match.record.players.flatMap(p=>p.pokemons)){figure.pokepower=figure.pokemon_index===owner?1064:-1;figure.skills=[attack(figure.pokemon_index===owner?1199:1018,figure.pokemon_index===owner?1:2,figure.pokemon_index===owner?100:2)];}
  const actions=structuredClone(primary.record.all_moves.slice(0,-1));
  if(owner===6)actions.splice(actions.length-1,1,{selective_side:'white',value:{type:'null_move'}},{selective_side:'black',value:{type:'declare_battle',from_pokemon:0,to_pokemon:6}});
  try {
    for(const action of actions)service.acceptPlayerMove(match,action,action.selective_side);
    for(let i=0;i<200&&match.battleResolutionPending;i++)await delay(5);
    assert.equal(match.battleResolutionPending,false);assert.deepEqual(rejected,[]);
    assert.equal(match.conditions.get(owner),'normal');assert.equal(match.turn,owner===0?'black':'white');
    const next={selective_side:match.turn,value:{type:'mp_move',route:owner===0?[15,20]:[11,6]}};
    assert.equal(rules.validateMovement(match,match.turn,next),true);service.acceptPlayerMove(match,next,next.selective_side);
    assert.deepEqual(rejected,[]);assert.equal(match.positions.get(owner),next.value.route.at(-1));
  } finally {match.phase='finished';}
});
