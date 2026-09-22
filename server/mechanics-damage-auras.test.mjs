import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {damageAuraSources} from './damage-auras.mjs';
const rows=[{ability:1218,id:1131,type:11,bonus:10},{ability:1307,id:1405,type:3,bonus:20},{ability:1352,id:1419,type:6,bonus:20},{ability:1411,id:1410,type:0,bonus:20},
  {ability:1243,id:1281,type:8,bonus:20},{ability:1371,id:1423,type:9,bonus:20},{ability:1409,id:1412,type:15,bonus:20},{ability:1420,id:1535,type:3,bonus:20},{ability:1422,id:1536,type:5,bonus:20},{ability:1466,id:1542,type:1,bonus:20}];
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,rule,color=1) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('damage-aura');
  const enemy=owner===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p);
  for(const f of figures){f.pokepower=-1;f.id=1002;f.skills=[attack(1199,1,100)];}
  figure(owner).id=rule.id;figure(owner).skills=[attack(color===1?1199:color===3?1003:color===2?1009:color===4?1122:1131,color,color===2?2:color===0||color===4?0:50)];
  figure(owner+1).id=rule.id;figure(owner+1).pokepower=rule.ability;
  match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);match.positions.set(owner+1,owner===0?21:0);
  return {service,match,owner,enemy,figure};
}
test('original type names, ten figure/ability bindings, and damage-notice source identity are explicit',()=>{
  const master=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
  const text=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;
  for(const [type,name]of [[11,'Ground'],[3,'Psychic'],[6,'Steel'],[0,'Dark'],[8,'Water'],[9,'Ice'],[15,'Ghost'],[5,'Normal'],[1,'Electric']])assert(text.some(r=>r.text_key===`FigureMaster.TypeName.${type}`&&r.text===name));
  for(const rule of rows)assert.equal(master[rule.id].pokepower_id,rule.ability);
  const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/damage-aura-contract.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.equal(contract.original_code_executed,false);
  assert.deepEqual(contract.types.find(t=>t.type.endsWith('/PokepowerDamageNotice')).properties,[{name:'source',type:'System.Int32'}]);
  assert.equal(contract.types.find(t=>t.type.endsWith('/PokepowerDamageNotice_Sum')).properties[0].type,'Monaco.Client.Scenes.Match.AiAction/DamageSumNotice');
  const consumers=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/damage-aura-consumers.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  const remap=consumers.methods.find(m=>m.token==='[Method:0x2136]').instructions;
  const index=remap.findIndex(line=>line.includes('PokepowerDamageNotice::get_source'));
  assert.match(remap[index+1],/CharaReversed/,'source is a figure index, not an ability ID');
});
for(const rule of rows)for(const owner of [0,6])for(const color of [0,1,2,3,4])test(`${owner}: aura ${rule.ability} applies only to allied field White/Gold damage (${color})`,()=>{
  const {match,enemy,figure}=fixture(owner,rule,color),authored=structuredClone(figure(owner).skills),selected=engine.selectedSkill(match,owner,0);
  const expected=[1,3].includes(color)?rule.bonus:0;
  engine.applyConditionBattleDamage(match,owner,enemy,selected);
  assert.equal(selected.speed_or_damage,authored[0].speed_or_damage+expected);
  assert.equal(selected.damage_aura_bonus??0,expected);assert.deepEqual(figure(owner).skills,authored);
  if(expected)assert.deepEqual(selected.damage_aura_changes,[{source:owner+1,pokepower:rule.ability,addend:rule.bonus,current:50,result:50+rule.bonus}]);
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: aura ${rule.ability} includes self; excludes enemy, wrong-type and off-field sources/targets`,()=>{
  const {match,enemy,figure}=fixture(owner,rule),selected=engine.selectedSkill(match,owner,0);
  for(const point of [28+owner+1,40,41,42,43,-1]){match.positions.set(owner+1,point);assert.deepEqual(damageAuraSources(match.record,match.positions,match.conditions,owner,selected),[]);}
  figure(owner+1).pokepower=-1;figure(enemy).pokepower=rule.ability;
  assert.deepEqual(damageAuraSources(match.record,match.positions,match.conditions,owner,selected),[]);
  figure(owner).pokepower=rule.ability;
  assert.equal(damageAuraSources(match.record,match.positions,match.conditions,owner,selected)[0].source,owner);
  figure(owner).id=1001;assert.deepEqual(damageAuraSources(match.record,match.positions,match.conditions,owner,selected),[]);
  figure(owner).id=rule.id;match.positions.set(owner,28+owner);assert.deepEqual(damageAuraSources(match.record,match.positions,match.conditions,owner,selected),[]);
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: aura ${rule.ability} checks the source's exact healthy clause, independently of the target`,()=>{
  const {match,enemy}=fixture(owner,rule);
  for(const condition of special){
    match.conditions.set(owner+1,condition);match.waits.set(owner+1,3);
    const selected=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,selected);
    assert.equal(selected.speed_or_damage,rule.ability===1218?50:50+rule.bonus,condition);
  }
  match.conditions.set(owner+1,'normal');match.conditions.set(owner,'poison');
  const selected=engine.selectedSkill(match,owner,0);engine.applyConditionBattleDamage(match,owner,enemy,selected);
  assert.equal(selected.speed_or_damage,50+rule.bonus-20);
});
test('every catalog alias uses original type membership; overlapping identical types do not double one source',()=>{
  const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
  for(const rule of rows) {
    const {match,figure}=fixture(0,rule);
    for(const [id,row]of Object.entries(catalog.figures)) {
      figure(0).id=Number(id);figure(0).type=rule.type;
      const sources=damageAuraSources(match.record,match.positions,match.conditions,0,{color:1});
      assert.equal(sources.length,Number(row.playable&&[row.type0,row.type1].includes(rule.type)),`${rule.ability}/${id}`);
    }
    figure(0).id=900000099;assert.deepEqual(damageAuraSources(match.record,match.positions,match.conditions,0,{color:1}),[]);
  }
});
for(const owner of [0,6])test(`${owner}: additive aura copies stack once each after repeat/retry/1621, before plate/condition terms (derived order)`,()=>{
  const rule=rows[0],{match,enemy,figure}=fixture(owner,rule);
  figure(owner+2).pokepower=1218;match.positions.set(owner+2,owner===0?22:1);match.damageBonuses.set(owner,30);
  for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676,1621]) {
    const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id);
    figure(owner).skills=[attack(id,1,50,48),attack(1131,0,0,48)];
    match.conditions.set(enemy,id===1621?'paralyze':'normal');match.conditions.set(owner,'poison');
    const units=repeat?[0,0,0,48]:id===1621?[0]:[0,0];
    const selected=engine.selectedSpinSkill(match,owner,units.map((num,index)=>({num,displace:0,type:index?'probability':'battle'})));
    engine.applyConditionBattleDamage(match,owner,enemy,selected);
    const raw=repeat?150:id===1301?70:100;
    assert.equal(selected.speed_or_damage,raw+20+30-20,String(id));
    assert.deepEqual(selected.damage_aura_changes.map(c=>[c.current,c.result]),[[raw,raw+10],[raw+10,raw+20]]);
  }
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: aura ${rule.ability} changes real battle comparison and source departure restores original damage`,()=>{
  for(const offset of [-1,0,1]) {
    const {service,match,enemy,figure}=fixture(owner,rule);figure(enemy).skills=[attack(1199,1,50+rule.bonus+offset)];
    const result=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal(result.attackerSkill.speed_or_damage,50+rule.bonus);
    assert.equal(result.winner,offset<0?owner:offset>0?enemy:-1);assert.equal(result.knockout,offset!==0);
  }
  const {service,match,enemy,figure}=fixture(owner,rule);figure(enemy).skills=[attack(1199,1,50)];match.positions.set(owner+1,28+owner+1);
  assert.equal(service.applyBaseBattleOutcome(match,owner,enemy,0,0).winner,-1);
});
