import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchContract,customMatchTestHooks as engine} from './custom-match-engine.mjs';
import {battleColorActions,applyBattleColorActions,withinBattleColorDistance} from './battle-colors.mjs';
const graph=customMatchContract.fieldEdges;
const masters=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
const skill=(id,color,power=50,width=96)=>({id,color,speed_or_damage:power,range:width});
function fixture(owner,ability){
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('battle-color-scope'),enemy=owner===0?6:0;
  const figures=match.record.players.flatMap(p=>p.pokemons),figure=p=>figures.find(f=>f.pokemon_index===p),source=ability===1197?owner:owner+1;
  for(const f of figures){f.id=1001;f.pokepower=-1;f.skills=[skill(1122,4,0)];}
  match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);match.positions.set(owner+1,owner===0?20:6);
  match.turn=owner===0?'black':'white';figure(source).id={1197:1318,1392:1544,1262:1342}[ability];figure(source).pokepower=ability;
  const target=ability===1197?owner:enemy;
  figure(target).skills=[skill(1199,ability===1197?1:3)];
  if(ability===1197)figure(owner+1).id=1318;
  if(ability===1392)figure(owner).id=1544;
  const actions=()=>battleColorActions(match.record,match.positions,match.battledAfterField,owner,enemy,graph,match.turn);
  return {service,match,owner,enemy,source,target,figure,actions};
}
for(const [ability,id,pattern]of [[1197,1318,/adjacent Durant.*White Attacks become Gold Attacks/],[1392,1544,/battle opponents of your Dragon-type and Psychic-type Pokémon become White Attacks/],[1262,1342,/only valid on your turn.*Gold Attacks of Pokémon within 2 steps/]])test(`${ability}: original binding and exact scoped color clause`,()=>{assert.equal(masters[id].pokepower_id,ability);assert.match(masters[id].pokepower_description,pattern);});
test('recovered board distances agree with independent all-pairs relaxation and never cross field bounds',()=>{
  const distances=Array.from({length:28},(_,a)=>Array.from({length:28},(_,b)=>a===b?0:Infinity));
  for(const [a,b]of graph)distances[a][b]=distances[b][a]=1;
  for(let k=0;k<28;k++)for(let a=0;a<28;a++)for(let b=0;b<28;b++)distances[a][b]=Math.min(distances[a][b],distances[a][k]+distances[k][b]);
  for(let a=0;a<28;a++)for(let b=0;b<28;b++)for(const max of [0,1,2,3])assert.equal(withinBattleColorDistance(a,b,graph,max),distances[a][b]<=max,`${a}/${b}/${max}`);
  assert.equal(distances[20][11],2);assert.equal(distances[27][11],3);assert.equal(distances[6][0],4);
  for(const off of [-1,28,35,40,41,42,43]){assert.equal(withinBattleColorDistance(off,11,graph,99),false);assert.equal(withinBattleColorDistance(11,off,graph,99),false);}
});
for(const owner of [0,6]){
  test(`1197/${owner}: ally or enemy Durant adjacent to the holder promotes all White IDs; source is not its own neighbor`,()=>{
    const {match,enemy,figure,actions}=fixture(owner,1197);const ally=owner+1;
    for(const neighbor of [ally,enemy]){
      figure(ally).id=1001;figure(enemy).id=1001;figure(neighbor).id=1318;
      assert.deepEqual(actions(),[{pokemon:owner,pokepower:1197,type:'pokepower_notice'},{pokemon:owner,skill_id:[1199],type:'speedup_skill'}]);
    }
    figure(enemy).id=1001;assert.deepEqual(actions(),[],'holder itself is not an adjacent second Durant');
    figure(ally).name='Durant';figure(ally).poke_no=632;assert.deepEqual(actions(),[],'untrusted display/species hints cannot confer Durant identity');
  });
  test(`1197/${owner}: neighboring field departure/type mismatch releases conversion and re-entry restores it`,()=>{
    const {match,figure,actions}=fixture(owner,1197),ally=owner+1,point=match.positions.get(ally);
    for(const off of [28+ally,40,41,42,43,-1]){match.positions.set(ally,off);assert.deepEqual(actions(),[]);}
    match.positions.set(ally,owner===0?27:5);assert.deepEqual(actions(),[],'distance2 does not satisfy adjacency');
    match.positions.set(ally,point);assert.equal(actions().length,2);
    figure(ally).id=900000099;assert.deepEqual(actions(),[]);
    figure(ally).id=1318;match.positions.set(owner,28+owner);assert.deepEqual(actions(),[]);
  });
  test(`1197/${owner}: every catalog alias is checked against the original canonical Durant identity`,()=>{
    const {figure,actions}=fixture(owner,1197);
    for(const [id,row]of Object.entries(catalog.figures)){figure(owner+1).id=Number(id);assert.equal(actions().length,row.playable&&row.rule_poke_id===1318?2:0,id);}
  });
  test(`1392/${owner}: field source protects allied Dragon/Psychic participants regardless of source distance`,()=>{
    const {match,source,enemy,figure,actions}=fixture(owner,1392);
    for(const [id,row]of Object.entries(catalog.figures)){figure(owner).id=Number(id);const expected=row.playable&&[row.type0,row.type1].some(t=>[16,3].includes(t));assert.equal(actions().length,expected?2:0,id);}
    figure(owner).id=1544;match.positions.set(source,owner===0?22:0);
    assert.deepEqual(actions(),[{pokemon:source,pokepower:1392,type:'pokepower_notice'},{pokemon:enemy,skill_id:[1199],type:'speeddown_skill'}]);
    figure(owner).id=900000099;figure(owner).types=[16,3];assert.deepEqual(actions(),[]);
  });
  test(`1392/${owner}: source itself is protected, opposing species is not, and off-field sources do not act`,()=>{
    const {match,source,enemy,figure,actions}=fixture(owner,1392);figure(source).pokepower=-1;figure(owner).pokepower=1392;
    assert.equal(actions().length,2,'holder protects its own Dragon/Psychic battle');
    figure(owner).pokepower=-1;figure(enemy).pokepower=1392;figure(enemy).id=1544;figure(owner).skills=[skill(1199,3)];
    assert.deepEqual(actions(),[{pokemon:enemy,pokepower:1392,type:'pokepower_notice'},{pokemon:owner,skill_id:[1199],type:'speeddown_skill'}]);
    figure(enemy).pokepower=-1;figure(source).pokepower=1392;
    for(const off of [28+source,40,41,42,43,-1]){match.positions.set(source,off);assert.deepEqual(actions(),[]);}
  });
  test(`1262/${owner}: holder turn and exact two-step scope gate both battle participants`,()=>{
    const {match,source,enemy,figure,actions}=fixture(owner,1262);
    assert.deepEqual(actions(),[{pokemon:enemy,skill_id:[1199],type:'speeddown_skill'}]);
    match.turn=owner===0?'white':'black';assert.deepEqual(actions(),[]);
    match.turn=owner===0?'black':'white';match.positions.set(source,owner===0?27:5);assert.deepEqual(actions(),[],'opponent is3 steps away');
    match.positions.set(source,owner===0?20:6);figure(owner).skills=[skill(1347,3,99)];
    assert.deepEqual(actions(),[{pokemon:enemy,skill_id:[1199],type:'speeddown_skill'},{pokemon:owner,skill_id:[1347],type:'speeddown_skill'}]);
    for(const off of [28+source,40,41,42,43,-1]){match.positions.set(source,off);assert.deepEqual(actions(),[]);}
  });
  test(`1262/${owner}: distance-zero inclusion is explicit derived scope; source may affect self and foe without changing damage`,()=>{
    const {match,source,enemy,figure,actions}=fixture(owner,1262);figure(source).pokepower=-1;figure(owner).id=1342;figure(owner).pokepower=1262;figure(owner).skills=[skill(1347,3,99)];
    const moves=actions();assert.equal(moves.length,2);const own=skill(1347,3,99);applyBattleColorActions(owner,own,moves);assert.equal(own.color,1);assert.equal(own.speed_or_damage,99);
    const foe=skill(1199,3);applyBattleColorActions(enemy,foe,moves);assert.equal(foe.color,1);
  });
}
for(const ability of [1197,1392,1262])for(const owner of [0,6]){
  test(`${ability}/${owner}: actual battle outcomes change color priority, then scope is reevaluated for the next battle`,()=>{
    const {service,match,enemy,target,source,figure}=fixture(owner,ability);
    const initial=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal((target===owner?initial.attackerSkill:initial.defenderSkill).color,ability===1197?3:1);assert.equal(initial.knockout,false);
    assert.equal(match.battledAfterField.get(owner),true);
    if(ability===1197)figure(owner+1).id=1001;
    else if(ability===1392)match.positions.set(source,28+source);
    else match.turn=owner===0?'white':'black';
    const later=service.applyBaseBattleOutcome(match,owner,enemy,0,0);
    assert.equal((target===owner?later.attackerSkill:later.defenderSkill).color,ability===1197?1:3);
  });
  test(`${ability}/${owner}: actual attacking/defending contexts honor the source turn and Purple priority`,()=>{
    for(const defending of [false,true]){
      const {service,match,enemy,target,figure}=fixture(owner,ability),actor=defending?enemy:owner,defender=defending?owner:enemy;
      match.turn=actor===0?'black':'white';figure(target===owner?enemy:owner).skills=[skill(1009,2,1)];
      const outcome=service.applyBaseBattleOutcome(match,actor,defender,0,0),selected=target===actor?outcome.attackerSkill:outcome.defenderSkill;
      const active=ability!==1262||!defending;assert.equal(selected.color,active?(ability===1197?3:1):(ability===1197?1:3));
      assert.equal(outcome.winner,selected.color===3?target:(target===owner?enemy:owner));
    }
  });
  test(`${ability}/${owner}: source/neighbor conditions and Wait do not invent suppression; disabled/Z skills retain resolved color`,()=>{
    const {match,source,target,actions}=fixture(owner,ability);
    for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']){match.conditions.set(source,condition);match.conditions.set(owner+1,condition);match.waits.set(source,3);assert.equal(actions().length,ability===1262?1:2);}
    const moves=actions();for(const flag of ['disabled_replacement','z_skill']){const value={...skill(1199,ability===1197?1:3),[flag]:true},before=structuredClone(value);applyBattleColorActions(target,value,moves);assert.deepEqual(value,before);}
  });
}
for(const owner of [0,6])test(`${owner}: Team Fight promotion and Psychic Surge demotion preserve both typed operations in derived restoration order`,()=>{
  const {match,source,figure,actions}=fixture(owner,1197);figure(owner+2).id=1342;figure(owner+2).pokepower=1262;match.positions.set(owner+2,owner===0?27:5);
  const moves=actions();assert.deepEqual(moves.map(m=>m.type),['pokepower_notice','speedup_skill','speeddown_skill']);
  const value=skill(1199,1);applyBattleColorActions(owner,value,moves);assert.equal(value.color,1);assert.equal(value.original_color,1);
  assert.equal(source,owner);
});
