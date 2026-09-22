import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {applyFieldCountDamage} from './damage-auras.mjs';
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('field-count-damage');
  const enemy=owner===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p);
  for(const f of figures){f.id=1001;f.pokepower=-1;f.skills=[attack(1199,1,50)];}
  figure(owner).id=1281;figure(owner).pokepower=1243;match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);
  return {service,match,owner,enemy,figure};
}
test('Intense Shell Cannon independently specifies self Water count and allied Water+20; original ProductSum wrapper exists',()=>{
  const master=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures[1281];
  assert.equal(master.pokepower_id,1243);
  assert.equal(master.pokepower_description,'This Pokémon deals +10 damage for each Water-type Pokémon on the field. Your Water-type Pokémon each deal +20 damage.');
  const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/damage-aura-contract.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.equal(contract.types.find(t=>t.type.endsWith('/PokepowerDamageNotice_ProductSum')).properties[0].type,'Monaco.Client.Scenes.Match.AiAction/DamageProductSumNotice');
  assert(contract.types.find(t=>t.type.endsWith('/DamageProductSumNotice')).properties.some(p=>p.name==='multiplicand'&&p.type==='System.Int32'));
});
for(const owner of [0,6])test(`${owner}: every field count across both teams adds10 per figure and exactly20 from its own Water aura`,()=>{
  const {match,enemy,figure}=fixture(owner);
  const members=[owner,...Array.from({length:12},(_,p)=>p).filter(p=>p!==owner)];
  for(let count=1;count<=12;count++) {
    for(const [i,pokemon]of members.entries()){figure(pokemon).id=i<count?1281:1001;match.positions.set(pokemon,i);}
    const skill=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,skill);
    assert.equal(skill.speed_or_damage,50+count*10+20);assert.equal(skill.field_count_damage_bonus,count*10);assert.equal(skill.damage_aura_bonus,20);
    assert.equal(skill.field_count_damage_change.multiplier,count);assert.equal(skill.field_count_damage_change.multiplicand,10);
    assert.deepEqual(skill.field_count_damage_change.counted,[...members.slice(0,count)].sort((a,b)=>a-b));
    assert.deepEqual(skill.damage_aura_changes.map(c=>[c.current,c.result]),[[50+count*10,70+count*10]]);
  }
});
for(const owner of [0,6])test(`${owner}: only the ability holder receives the count term; field departure and identity changes update the next attack`,()=>{
  const {match,enemy,figure}=fixture(owner);figure(enemy).id=1002;figure(owner+1).id=1281;match.positions.set(owner+1,owner===0?21:0);
  let skill=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,skill);assert.equal(skill.speed_or_damage,100);
  skill=engine.selectedSkill(match,owner+1,0);engine.applyConditionBattleDamage(match,owner+1,enemy,skill);
  assert.equal(skill.speed_or_damage,70);assert.equal(skill.field_count_damage_bonus,undefined,'ally receives only the aura');
  for(const point of [28+enemy,40,41,42,43,-1]){
    match.positions.set(enemy,point);skill=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,skill);assert.equal(skill.speed_or_damage,90);
  }
  match.positions.set(enemy,owner===0?11:15);figure(enemy).id=1001;
  skill=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,skill);assert.equal(skill.speed_or_damage,90);
});
for(const owner of [0,6])test(`${owner}: Water count ignores marker/condition labels and non-damaging colors`,()=>{
  const {match,enemy,figure}=fixture(owner);figure(enemy).id=1002;
  for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']){
    match.conditions.set(enemy,condition);match.waits.set(enemy,3);
    const skill=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,skill);assert.equal(skill.speed_or_damage,90);
  }
  for(const color of [0,2,4]){const skill=attack(1131,color,0),before=structuredClone(skill);applyFieldCountDamage(match.record,match.positions,owner,skill);assert.deepEqual(skill,before);}
  match.positions.set(owner,28+owner);const skill=attack(1199,1,50);applyFieldCountDamage(match.record,match.positions,owner,skill);assert.equal(skill.speed_or_damage,50);
});
test('every catalog item is counted once by original Water type, including dual types and aliases',()=>{
  const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
  const {match,figure}=fixture(0);
  for(const [id,row]of Object.entries(catalog.figures)) {
    figure(6).id=Number(id);figure(6).name='Water';figure(6).type=8;
    const skill=attack(1199,1,50);applyFieldCountDamage(match.record,match.positions,0,skill);
    const count=1+Number(row.playable&&[row.type0,row.type1].includes(8));
    assert.equal(skill.speed_or_damage,50+count*10,id);assert.equal(skill.field_count_damage_change.counted.length,count,id);
  }
  for(const id of [-1,900000099]){figure(6).id=id;const skill=attack(1199,1,50);applyFieldCountDamage(match.record,match.positions,0,skill);assert.equal(skill.speed_or_damage,60);}
});
for(const owner of [0,6])test(`${owner}: count term stays separate from repeated/conditional skill, flat aura, plate and poison terms`,()=>{
  const {match,enemy,figure}=fixture(owner);figure(enemy).id=1002;match.damageBonuses.set(owner,30);match.conditions.set(owner,'poison');
  for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676,1621]) {
    const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id);
    figure(owner).skills=[attack(id,1,50,48),attack(1131,0,0,48)];match.conditions.set(enemy,id===1621?'paralyze':'normal');
    const units=repeat?[0,0,0,48]:id===1621?[0]:[0,0],raw=repeat?150:id===1301?70:100;
    const skill=engine.selectedSpinSkill(match,owner,units.map((num,index)=>({num,displace:0,type:index?'probability':'battle'})));
    engine.applyConditionBattleDamage(match,owner,enemy,skill);
    assert.equal(skill.speed_or_damage,raw+20+20+30-20,String(id));
    assert.equal(skill.field_count_damage_change.current,raw);assert.equal(skill.field_count_damage_change.result,raw+20);
    assert.equal(skill.damage_aura_changes[0].current,raw+20);assert.equal(skill.condition_damage.current,raw+70);
  }
});
