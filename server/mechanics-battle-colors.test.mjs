import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {battleColorActions,applyBattleColorActions} from './battle-colors.mjs';
const data=JSON.parse(readFileSync(new URL('../data/battle_color_rules.json',import.meta.url)));
const bindings={1227:[1272,1273],1308:[1404],1409:[1412],1397:[1498],1398:[1503],1399:[1504,1648],1423:[1525]};
const baseRules=data.rules.filter(rule=>Object.hasOwn(bindings,rule.ability));
const masters=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
const skill=(id,color,power=50,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,rule){
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('battle-colors');
  const enemy=owner===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p);
  for(const f of figures){f.pokepower=-1;f.skills=[skill(1199,1)];}
  figure(owner).id=bindings[rule.ability][0];figure(owner).pokepower=rule.ability;
  match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);
  const target=rule.target==='self'?owner:enemy,other=target===owner?enemy:owner;
  figure(target).skills=[skill(1199,rule.from_color)];figure(other).skills=[skill(1122,4,0)];
  const actions=()=>battleColorActions(match.record,match.positions,match.battledAfterField,owner,enemy);
  return {service,match,owner,enemy,target,other,figure,actions};
}
for(const rule of baseRules)test(`${rule.ability}: exact original figure bindings and printed color/first-battle clause`,()=>{
  for(const id of bindings[rule.ability])assert.equal(masters[id].pokepower_id,rule.ability,String(id));
  const description=masters[bindings[rule.ability][0]].pokepower_description;
  assert.match(description,rule.target==='self'?/White Attacks become Gold Attacks/:/Gold Attacks.*become White Attacks/);
  assert.equal(/first battle/.test(description),rule.first_battle);
});
for(const rule of baseRules)for(const owner of [0,6]){
  test(`${rule.ability}/${owner}: a defending ability holder applies the same first-battle conversion in the actual engine`,()=>{
    const {service,match,enemy,target}=fixture(owner,rule);
    const outcome=service.applyBaseBattleOutcome(match,enemy,owner,0,0);
    assert.equal((target===owner?outcome.defenderSkill:outcome.attackerSkill).color,rule.to_color);
    assert.equal(outcome.knockout,false);assert.equal(match.battledAfterField.get(owner),true);
  });
  test(`${rule.ability}/${owner}: field first battle applies exact notice and every matching split Attack ID`,()=>{
    const {match,target,figure,actions}=fixture(owner,rule);
    figure(target).skills=[skill(1372,rule.from_color,50,12),skill(1199,rule.from_color,30,24),skill(1372,rule.from_color,50,12),skill(1131,0,0,24),skill(1122,4,0,24),skill(900,rule.from_color,100,0)];
    const before=structuredClone(match.record),moves=actions(),type=rule.to_color===3?'speedup_skill':'speeddown_skill';
    assert.deepEqual(moves,[{pokemon:owner,pokepower:rule.ability,type:'pokepower_notice'},{pokemon:target,skill_id:[1199,1372],type}]);
    for(const authored of figure(target).skills){const selected=structuredClone(authored);applyBattleColorActions(target,selected,moves);assert.equal(selected.color,[1199,1372].includes(authored.id)?rule.to_color:authored.color);assert.equal(selected.speed_or_damage,authored.speed_or_damage);}
    assert.deepEqual(match.record,before,'authored wheels remain unchanged');
  });
  test(`${rule.ability}/${owner}: actual result marks first battle once; field movement preserves and bench re-entry rearms it`,()=>{
    const {service,match,enemy,target,actions}=fixture(owner,rule);
    const check=expected=>{const result=service.applyBaseBattleOutcome(match,owner,enemy,0,0);assert.equal((target===owner?result.attackerSkill:result.defenderSkill).color,expected);assert.equal(result.knockout,false);assert.equal(match.battledAfterField.get(owner),true);};
    check(rule.to_color);check(rule.first_battle?rule.from_color:rule.to_color);
    const original=match.positions.get(owner),next=owner===0?16:6;
    engine.applyPositionMove(match,{value:{type:'spot_move',from:original,to:next}});
    assert.equal(actions().length,rule.first_battle?0:2);
    engine.applyPositionMove(match,{value:{type:'spot_move',from:next,to:28+owner}});
    assert.equal(match.battledAfterField.get(owner),false);assert.deepEqual(actions(),[]);
    engine.applyPositionMove(match,{value:{type:'spot_move',from:28+owner,to:original}});
    check(rule.to_color);
  });
  test(`${rule.ability}/${owner}: source/target scope and each nonmatching color reject the conversion`,()=>{
    const {match,enemy,target,figure,actions}=fixture(owner,rule);
    for(const color of [0,1,2,3,4].filter(c=>c!==rule.from_color)){figure(target).skills=[skill(1199,color)];assert.deepEqual(actions(),[]);}
    figure(target).skills=[skill(1199,rule.from_color)];
    const point=match.positions.get(owner);for(const destination of [-1,28+owner,40,41,42,43]){match.positions.set(owner,destination);assert.deepEqual(actions(),[]);}
    match.positions.set(owner,point);if(rule.target==='opponent'){match.positions.set(enemy,28+enemy);assert.deepEqual(actions(),[]);}
    figure(owner).pokepower=-1;assert.deepEqual(actions(),[]);
  });
  test(`${rule.ability}/${owner}: conditions do not suppress printed conversion; disabled and Z attacks keep their resolved color`,()=>{
    const {match,target,actions}=fixture(owner,rule);
    for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']){match.conditions.set(owner,condition);match.waits.set(owner,3);assert.equal(actions().length,2);}
    const moves=actions();
    for(const flag of ['disabled_replacement','z_skill']){const value={...skill(1199,rule.from_color),[flag]:true},before=structuredClone(value);applyBattleColorActions(target,value,moves);assert.deepEqual(value,before);}
    match.disabledSkills.set(target,new Set([1199]));const selected=engine.selectedSkill(match,target,0,0,moves);assert.equal(selected.color,0);assert.equal(selected.id,1131);assert.equal(selected.speedup_skill,undefined);assert.equal(selected.speeddown_skill,undefined);
  });
  test(`${rule.ability}/${owner}: conversion changes the actual Gold-versus-Purple winner and expires only on a later battle`,()=>{
    const {service,match,enemy,target,other,figure}=fixture(owner,rule);
    figure(other).skills=[skill(1009,2,1)];
    const outcome=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal((target===owner?outcome.attackerSkill:outcome.defenderSkill).color,rule.to_color);
    assert.equal(outcome.winner,rule.to_color===3?target:other);
    assert.equal(outcome.knockout,rule.to_color===3);
    if(rule.to_color===1){assert.equal(match.conditions.get(target),'panic');assert.equal(match.battledAfterField.get(owner),true);}
  });
}
for(const owner of [0,6])test(`${owner}: opposing first-battle promotion and unconditional demotion retain both ID operations in original client replay order`,()=>{
  const rule=data.rules.find(r=>r.ability===1227),{match,enemy,figure,actions}=fixture(owner,rule);
  figure(enemy).pokepower=1409;const moves=actions();
  assert.deepEqual(moves.map(m=>m.type),['pokepower_notice','speedup_skill','pokepower_notice','speeddown_skill']);
  const value=skill(1199,1);applyBattleColorActions(owner,value,moves);assert.equal(value.color,1);assert.equal(value.original_color,1);assert.equal(value.speedup_skill,true);assert.equal(value.speeddown_skill,true);
  match.battledAfterField.set(owner,true);assert.deepEqual(actions(),[],'later authored White needs neither operation');
});
for(const ability of [1227,1409])for(const owner of [0,6])test(`${ability}/${owner}: all repeated/retry IDs preserve actual result counts and flat plate damage during color conversion`,()=>{
  const rule=data.rules.find(r=>r.ability===ability),{match,target,figure,actions}=fixture(owner,rule);match.damageBonuses.set(target,30);
  for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676]){
    const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id),units=repeat?[0,0,0,48]:[0,0];
    figure(target).skills=[skill(id,rule.from_color,50,48),skill(1131,0,0,48)];
    const result=engine.selectedSpinSkill(match,target,units.map((num,i)=>({num,displace:0,type:i?'probability':'battle'})),actions());
    assert.equal(result.color,rule.to_color);assert.equal(result.speed_or_damage,(repeat?150:id===1301?70:100)+30,String(id));
  }
});
