import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {purpleStarSources,applyPurpleStars} from './purple-stars.mjs';
const rows=[{ability:1263,id:1146},{ability:1262,id:1342,type:3},{ability:1435,id:1524,type:7}];
const attack=(id,color,power,range=96)=>({id,color,speed_or_damage:power,range});
function fixture(owner,rule,color=2) {
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('purple-stars');
  const enemy=owner===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p),source=rule.ability===1263?owner:owner+1;
  for(const f of figures){f.pokepower=-1;f.id=1002;f.skills=[attack(1018,2,1)];}
  figure(owner).id=rule.id;figure(owner).skills=[attack(color===2?1009:color===0?1131:color===4?1122:1199,color,color===2?1:color===0||color===4?0:50)];
  figure(source).id=rule.id;figure(source).pokepower=rule.ability;
  match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);
  if(source!==owner)match.positions.set(source,owner===0?20:6);
  match.turn=owner===0?'black':'white';
  return {service,match,owner,enemy,source,figure};
}
const sources=f=>purpleStarSources(f.match.record,f.match.positions,f.match.battledAfterField,f.owner,engine.selectedSkill(f.match,f.owner,0),f.match.turn);
test('three printed star clauses bind both Espeons, Tapu Lele and Blacephalon; star value uses the original result contract',()=>{
  const master=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
  for(const [id,ability]of [[1146,1263],[1516,1263],[1342,1262],[1524,1435]])assert.equal(master[id].pokepower_id,ability);
  assert.match(master[1342].pokepower_description,/only valid on your turn/);assert.match(master[1342].pokepower_description,/not cumulative/);
  assert.match(master[1524].pokepower_description,/first battle after moving to the field/);
  const contract=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/purple-value-contract.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.equal(contract.original_code_executed,false);
  const m=contract.methods.find(m=>m.token==='[Method:0x2b19]');
  assert(m.instructions.includes('IL_0143: ldstr "★"'));assert(m.instructions.includes('IL_0158: callvirt System.Int32 Monaco.Client.Scenes.Match.AiAction/BattleResult/Result::get_speed_or_damage()'));
});
for(const rule of rows)for(const owner of [0,6])for(const color of [0,1,2,3,4])test(`${owner}: stars ${rule.ability} modify only Purple, preserve the authored wheel and other damage`,()=>{
  const f=fixture(owner,rule,color),original=structuredClone(f.figure(owner).skills),skill=engine.selectedSkill(f.match,owner,0);
  applyPurpleStars(f.match.record,f.match.positions,f.match.battledAfterField,owner,skill,f.match.turn);
  assert.equal(skill.speed_or_damage,original[0].speed_or_damage+(color===2?1:0));assert.equal(skill.purple_star_bonus??0,color===2?1:0);assert.deepEqual(f.figure(owner).skills,original);
  if(color===2)assert.deepEqual(skill.purple_star_sources,[{source:f.source,pokepower:rule.ability,bonus:1}]);
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: stars ${rule.ability} enforce field, team and type scopes without requiring a healthy source`,()=>{
  const f=fixture(owner,rule);assert.equal(sources(f).length,1);
  for(const point of [-1,28+f.source,40,41,42,43]){f.match.positions.set(f.source,point);assert.equal(sources(f).length,0);}
  f.match.positions.set(f.source,f.source===owner?(owner===0?15:11):(owner===0?22:0));
  assert.equal(sources(f).length,1,'field-wide aura is not restricted to nearby teammates');
  for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']){f.match.conditions.set(f.source,condition);f.match.waits.set(f.source,3);assert.equal(sources(f).length,1,condition);}
  f.figure(f.source).pokepower=-1;f.figure(f.enemy).pokepower=rule.ability;assert.equal(sources(f).length,0,'foreign-team source excluded');
  f.figure(f.enemy).pokepower=-1;f.figure(owner).pokepower=rule.ability;assert.equal(sources(f).length,1,'matching holder benefits from self');
  f.figure(owner).id=900000099;assert.equal(sources(f).length,0,'unknown identities do not spoof original type');
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: stars ${rule.ability} change actual Purple winner, tie and effects in either battle role`,()=>{
  for(const defending of [false,true])for(const enemyStars of [1,2,3]){
    const f=fixture(owner,rule);f.figure(f.enemy).skills=[attack(1018,2,enemyStars)];
    const result=f.service.applyBaseBattleOutcome(f.match,defending?f.enemy:owner,defending?owner:f.enemy,0,0);
    assert.equal((defending?result.defenderSkill:result.attackerSkill).speed_or_damage,2);
    assert.equal(result.winner,enemyStars===1?owner:enemyStars===2?-1:f.enemy);assert.equal(result.knockout,false);
    assert.equal(f.match.conditions.get(f.enemy),enemyStars===1?'panic':'normal');assert.equal(f.match.conditions.get(owner),enemyStars===3?'sleep':'normal');
  }
  for(const color of [0,1,3,4]){
    const f=fixture(owner,rule);f.figure(f.enemy).skills=[attack(color===4?1122:color===0?1131:1199,color,color===1||color===3?99:0)];
    if(rule.ability===1262)f.match.positions.set(f.source,owner===0?27:5); // Star aura has no radius; keep Gold outside the separate color clause.
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
    assert.equal(result.attackerSkill.speed_or_damage,2);assert.equal(result.winner,[3,4].includes(color)?f.enemy:owner,'Gold/Blue priority unchanged');
  }
  if(rule.ability===1262){const f=fixture(owner,rule);f.figure(f.enemy).skills=[attack(1199,3,99)];const r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(r.attackerSkill.speed_or_damage,2);assert.equal(r.defenderSkill.color,1);assert.equal(r.winner,owner,'nearby color and field-wide star clauses compose');}
});
for(const rule of rows)for(const owner of [0,6])test(`${owner}: stars ${rule.ability} respect turn and source history without accumulating on the authored wheel`,()=>{
  const f=fixture(owner,rule);f.match.turn=owner===0?'white':'black';assert.equal(sources(f).length,rule.ability===1262?0:1);
  f.match.turn=owner===0?'black':'white';f.match.battledAfterField.set(f.source,true);assert.equal(sources(f).length,rule.ability===1435?0:1);
  f.match.battledAfterField.set(f.source,false);
  for(let n=0;n<3;n++){const skill=engine.selectedSkill(f.match,owner,0);applyPurpleStars(f.match.record,f.match.positions,f.match.battledAfterField,owner,skill,f.match.turn);assert.equal(skill.speed_or_damage,2);}
  for(const flag of ['disabled_replacement','z_skill'])assert.deepEqual(purpleStarSources(f.match.record,f.match.positions,f.match.battledAfterField,owner,{color:2,[flag]:true},f.match.turn),[]);
  f.figure(owner).skills=[attack(1009,2,1,48),attack(1131,0,0,48)];f.match.disabledSkills.set(owner,new Set([1009]));
  const disabled=engine.selectedSkill(f.match,owner,0);applyPurpleStars(f.match.record,f.match.positions,f.match.battledAfterField,owner,disabled,f.match.turn);assert.equal(disabled.color,0);assert.equal(disabled.speed_or_damage,0);
});
for(const owner of [0,6])test(`${owner}: Psychic stars are noncumulative and all original type aliases are checked`,()=>{
  const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
  for(const rule of rows.filter(r=>r.type!==undefined)){
    const f=fixture(owner,rule);f.figure(owner+2).id=rule.id;f.figure(owner+2).pokepower=rule.ability;f.match.positions.set(owner+2,owner===0?22:0);
    for(const [id,row]of Object.entries(catalog.figures)){
      f.figure(owner).id=Number(id);f.figure(owner).name=rule.type===3?'Espeon':'Blacephalon';f.figure(owner).type=rule.type;
      assert.equal(sources(f).length,row.playable&&[row.type0,row.type1].includes(rule.type)?(rule.ability===1262?1:2):0,`${rule.ability}/${id}`);
    }
  }
  for(const id of [1146,1516]){const f=fixture(owner,rows[0]);f.figure(owner).id=id;assert.equal(sources(f).length,1);f.figure(owner+1).id=id;f.figure(owner+1).pokepower=1263;f.match.positions.set(owner+1,owner===0?20:6);assert.equal(sources(f).length,1,'other Espeon cannot grant a second self bonus');}
});
for(const owner of [0,6])test(`${owner}: noncumulative Psychic source departure retains one remaining source; distinct star abilities add (derived)`,()=>{
  const f=fixture(owner,rows[1]);f.figure(owner).id=1146;f.figure(owner).pokepower=1263;
  f.figure(owner+2).id=1342;f.figure(owner+2).pokepower=1262;f.match.positions.set(owner+2,owner===0?22:0);
  assert.equal(sources(f).length,2);f.match.positions.set(owner+1,28+owner+1);assert.equal(sources(f).length,2);
  f.match.positions.set(owner+2,28+owner+2);assert.equal(sources(f).length,1);
  f.match.damageBonuses.set(owner,30);f.match.conditions.set(owner,'poison');
  const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(result.attackerSkill.speed_or_damage,2,'White/Gold plate and poison damage do not alter stars');
});
