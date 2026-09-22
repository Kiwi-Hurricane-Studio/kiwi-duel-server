import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {battleDamageReductionSource} from './battle-damage-reductions.mjs';
const special=['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep'];
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,ability,color=1,power=100){
 const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('battle-damage-reduction-isolated'),enemy=owner===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p);
 for(const f of figures){f.id=1005;f.mp=2;f.pokepower=-1;f.skills=[attack(1199,1,70)];}
 figure(owner).id=ability===1301?1392:1452;figure(owner).pokepower=ability;figure(enemy).id=1018;figure(enemy).skills=[attack(1199,color,power)];
 match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,enemy===0?15:11);match.conditions.set(owner,ability===1377?'poison':'normal');
 return {service,match,owner,enemy,figure};
}
test('two exact original bindings and Electric type are preserved',()=>{
 const figures=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
 for(const [id,ability]of [[1392,1301],[1452,1377]])assert.equal(figures[id].pokepower_id,ability);
 const texts=JSON.parse(readFileSync(new URL('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json',import.meta.url))).resources.localization_phase_1;assert(texts.some(t=>t.text_key==='FigureMaster.TypeName.1'&&t.text==='Electric'));
});
for(const ability of [1301,1377])for(const owner of [0,6])for(const color of [0,1,2,3,4])test(`${owner}: battle reduction ${ability} only changes White/Gold (${color})`,()=>{
 const f=fixture(owner,ability,color),m=f.match,authored=structuredClone(f.figure(f.enemy).skills),skill=engine.selectedSkill(m,f.enemy,0);engine.applyConditionBattleDamage(m,f.enemy,owner,skill);
 const reduction=[1,3].includes(color)?ability===1301?30:50:0;
 assert.equal(skill.speed_or_damage,100-reduction);assert.deepEqual(f.figure(f.enemy).skills,authored);
 assert.deepEqual(skill.battle_damage_reduction??null,reduction?{source:owner,pokepower:ability,addend:-reduction,current:100,result:100-reduction}:null);
});
for(const owner of [0,6])test(`${owner}: Marvel Scale reads all eight prior holder conditions, never Wait or attacker condition`,()=>{
 const f=fixture(owner,1377),m=f.match;
 for(const condition of [...special,'normal','faint','curse','wait']){
  m.conditions.set(owner,condition);m.waits.set(owner,7);m.conditions.set(f.enemy,'burn');const skill=engine.selectedSkill(m,f.enemy,0);engine.applyConditionBattleDamage(m,f.enemy,owner,skill);
  assert.equal(skill.speed_or_damage,90-(special.includes(condition)?50:0),condition);assert.equal(skill.condition_damage.result,90);
 }
 m.conditions.set(owner,'normal');m.conditions.set(f.enemy,'poison');assert.equal(battleDamageReductionSource(m.record,m.positions,m.conditions,f.enemy,owner,{color:1}),null);
});
for(const ability of [1301,1377])for(const owner of [0,6])test(`${owner}: battle reduction ${ability} rejects wrong holder, off-field, same-team and malformed participants`,()=>{
 const f=fixture(owner,ability),m=f.match,source=()=>battleDamageReductionSource(m.record,m.positions,m.conditions,f.enemy,owner,{color:1});assert(source());
 for(const p of [owner,f.enemy]){const saved=m.positions.get(p);for(const point of [-1,28+p,40,41,42,43]){m.positions.set(p,point);assert.equal(source(),null);}m.positions.set(p,saved);}
 f.figure(owner).pokepower=-1;f.figure(owner+1).pokepower=ability;m.positions.set(owner+1,20);m.conditions.set(owner+1,'poison');assert.equal(source(),null,'nearby holders do not act as a field aura');
 f.figure(owner).pokepower=ability;for(const invalid of [-1,12,0.5,NaN])assert.equal(battleDamageReductionSource(m.record,m.positions,m.conditions,invalid,owner,{color:1}),null);
 assert.equal(battleDamageReductionSource(m.record,m.positions,m.conditions,owner+1,owner,{color:1}),null);
});
for(const owner of [0,6])test(`${owner}: Lightning Rod checks every original figure alias and ignores supplied type overrides`,()=>{
 const f=fixture(owner,1301),m=f.match,catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
 for(const [id,row]of Object.entries(catalog.figures)){f.figure(f.enemy).id=Number(id);f.figure(f.enemy).type=1;const source=battleDamageReductionSource(m.record,m.positions,m.conditions,f.enemy,owner,{color:1});assert.equal(!!source,!!row.playable&&[row.type0,row.type1].includes(1),id);}
 f.figure(f.enemy).id=900000099;assert.equal(battleDamageReductionSource(m.record,m.positions,m.conditions,f.enemy,owner,{color:1}),null);
});
for(const ability of [1301,1377])for(const owner of [0,6])test(`${owner}: reduction ${ability} applies once after repeated/retry damage, plate, aura and condition (derived order)`,()=>{
 const f=fixture(owner,ability),m=f.match;f.figure(f.enemy+1).id=1542;f.figure(f.enemy+1).pokepower=1466;m.positions.set(f.enemy+1,owner===0?6:20);m.damageBonuses.set(f.enemy,30);m.conditions.set(f.enemy,'poison');
 for(const id of [1168,1172,1201,1261,1273,1310,1361,1369,1596,1283,1301,1307,1492,1533,1676]){
  const repeat=[1168,1172,1201,1261,1273,1310,1361,1369,1596].includes(id);f.figure(f.enemy).skills=[attack(id,1,50,48),attack(1131,0,0,48)];const units=repeat?[0,0,0,48]:[0,0];
  const skill=engine.selectedSpinSkill(m,f.enemy,units.map((num,i)=>({num,displace:0,type:i?'probability':'battle'})));engine.applyConditionBattleDamage(m,f.enemy,owner,skill);const raw=repeat?150:id===1301?70:100,current=raw+20+30-20;
  assert.equal(skill.speed_or_damage,current-(ability===1301?30:50),String(id));assert.equal(skill.condition_damage.current,raw+50);assert.equal(skill.battle_damage_reduction.current,current);assert.equal(skill.battle_damage_reduction.source,owner);
 }
});
for(const ability of [1301,1377])for(const owner of [0,6])test(`${owner}: reduction ${ability} has explicit zero-floor and exact threshold results`,()=>{
 // zero-damage-reductions-research.json: zero omits the modifier notice;
 // positive damage retains signed arithmetic independently of the final floor.
 for(const raw of [0,1,29,30,31,49,50,51,99,100]){const f=fixture(owner,ability,1,raw),skill=engine.selectedSkill(f.match,f.enemy,0);engine.applyConditionBattleDamage(f.match,f.enemy,owner,skill);const amount=ability===1301?30:50;assert.equal(skill.speed_or_damage,Math.max(0,raw-amount));assert.deepEqual(skill.battle_damage_reduction,raw===0?undefined:{source:owner,pokepower:ability,addend:-amount,current:raw,result:raw-amount});}
});
for(const ability of [1301,1377])for(const owner of [0,6])for(const defending of [false,true])test(`${owner}: reduction ${ability} changes the real battle winner when holder ${defending?'defends':'attacks'}`,()=>{
 for(const offset of [-1,0,1]){const f=fixture(owner,ability),m=f.match;const holderDamage=ability===1377?50:70;f.figure(owner).skills=[attack(1199,1,holderDamage+(ability===1377?20:0)+offset)];
  const actor=defending?f.enemy:owner,target=defending?owner:f.enemy;const result=f.service.applyBaseBattleOutcome(m,actor,target,0,0);
  assert.equal(result.winner,offset<0?f.enemy:offset>0?owner:-1);assert.equal((defending?result.attackerSkill:result.defenderSkill).speed_or_damage,holderDamage);
  assert.equal(m.positions.get(offset<0?owner:f.enemy),offset===0?(offset<0?owner:f.enemy)===0?15:11:(offset<0?owner:f.enemy)===0?41:43);
 }
});
for(const owner of [0,6])test(`${owner}: both eligible battle opponents reduce reciprocal damage from the same prior snapshot`,()=>{
 const f=fixture(owner,1377),m=f.match;f.figure(f.enemy).pokepower=1377;f.figure(f.enemy).id=1452;m.conditions.set(f.enemy,'poison');f.figure(owner).skills=[attack(1199,1,100)];
 const result=f.service.applyBaseBattleOutcome(m,owner,f.enemy,0,0);assert.equal(result.attackerSkill.speed_or_damage,30);assert.equal(result.defenderSkill.speed_or_damage,30);assert.equal(result.winner,-1);
});
for(const ability of [1301,1377])test(`seeded damage reduction ${ability} checks256 actual battle comparisons`,()=>{
 let seed=(0x66ac0000+ability)>>>0;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/0x100000000*n);};
 for(let i=0;i<256;i++){const owner=random(2)*6,condition=[...special,'normal'][random(9)],raw=random(250),power=random(250),f=fixture(owner,ability,1,raw);f.match.conditions.set(owner,condition);f.figure(owner).skills=[attack(1199,1,power)];const holderPower=Math.max(0,power-({burn:10,poison:20,bad_poison:40}[condition]??0)),enemyPower=Math.max(0,raw-(ability===1301?30:special.includes(condition)?50:0)),result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(result.attackerSkill.speed_or_damage,holderPower);assert.equal(result.defenderSkill.speed_or_damage,enemyPower);assert.equal(result.winner,holderPower>enemyPower?owner:holderPower<enemyPower?f.enemy:-1);}
});
