import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CustomMatchService,customMatchTestHooks as engine,customMatchContract as contract} from './custom-match-engine.mjs';
import {effectKnockoutProtectionSources as protection,purpleEffectKnockoutPlan as plan} from './effect-knockouts.mjs';
const data=JSON.parse(readFileSync(new URL('../data/effect_knockout_rules.json',import.meta.url)));
const coverage=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const catalog=JSON.parse(readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url)));
const skill=(id,color=2,power=3,range=96)=>({id,color,speed_or_damage:power,range});
const bindings={1143:1222,1276:1349,1381:1451,1427:1548,1428:1586,1429:1620,1476:1605};
function fixture(owner=0,id=1090,power=1){
  const service=new CustomMatchService({port:0,clockSource:()=>0}),match=service.createMatch('effect-knockout');
  const enemy=owner===0?6:0,figure=p=>match.record.players.flatMap(x=>x.pokemons).find(f=>f.pokemon_index===p);
  for(const player of match.record.players)for(const f of player.pokemons){f.pokepower=-1;f.id=1002;f.skills=[skill(1199,1,50)];}
  figure(owner).skills=[skill(id,2,power)];
  match.positions.set(owner,owner===0?15:11);match.positions.set(enemy,owner===0?11:15);match.turn=owner===0?'black':'white';
  return {service,match,owner,enemy,figure};
}
function protectedFixture(owner,ability){
  const f=fixture(owner),target=f.enemy,rule=data.protections.find(r=>r.ability===ability),holder=rule.target==='self'?target:target+1;
  f.figure(holder).id=bindings[ability];f.figure(holder).pokepower=ability;
  if(holder!==target)f.match.positions.set(holder,target===0?20:6);
  if(rule.target_type===2)f.figure(target).id=1022;
  if(rule.target_type===17)f.figure(target).id=1342;
  if(rule.emitter_type===0)f.figure(owner).id=1008;
  if(rule.owner_turn_only)f.match.turn=target===0?'black':'white';
  return {...f,target,holder,rule};
}
const protectedBy=(f,target=f.enemy,emitter=f.owner)=>protection(f.match.record,f.match.positions,f.match.conditions,target,emitter,f.match.turn,contract.fieldEdges);

test('all six Purple IDs, thirteen original variants and seven ability bindings are explicit',()=>{
  const masters=JSON.parse(readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).figures;
  let variants=0;
  for(const rule of data.purple_attacks){const e=coverage.entries.find(e=>e.key==='skill:'+rule.skill);assert(e);assert(e.variants.every(v=>v.color===2));variants+=e.variants.length;}
  assert.equal(variants,13);for(const [ability,id]of Object.entries(bindings))assert.equal(masters[id].pokepower_id,Number(ability));
  const schema=JSON.parse(readFileSync(new URL('../docs/generated/mechanics-20260913/ai-action-schema.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  assert.equal(schema.original_code_executed,false);assert(schema.types.find(t=>t.type.endsWith('/TypeName')).fields.some(f=>f.name==='knockedout_move'&&f.constant===51));
});
for(const rule of data.purple_attacks)for(const owner of [0,6])test(`${owner}: effect KO ${rule.skill} uses every original variant and both battle roles`,()=>{
  const entry=coverage.entries.find(e=>e.key==='skill:'+rule.skill);
  for(const variant of entry.variants)for(const defending of [false,true]){
    const f=fixture(owner,rule.skill,variant.stars);f.figure(owner).id=variant.occurrences[0].figure_id;
    f.figure(owner).skills=[skill(rule.skill,2,variant.stars,variant.range),skill(1131,0,0,96-variant.range)];
    if(rule.skill===1112)f.figure(f.enemy).skills=[skill(1009,2,1)];
    f.match.turn=(defending?f.enemy:owner)===0?'black':'white';
    const before=new Map(f.match.positions),result=f.service.applyBaseBattleOutcome(f.match,defending?f.enemy:owner,defending?owner:f.enemy,0,0);
    const expected=rule.target==='both'?[0,6]:[f.enemy];
    assert.equal(result.winner,owner);assert.deepEqual(result.pendingKnockoutTargets,expected);assert.equal(result.knockout,false,'Center relocation stays in the completion path');
    assert.deepEqual(f.match.positions,before);for(const p of expected)assert.equal(f.match.conditions.get(p),'faint');
    assert.equal(!!result.inlineKnockoutBatch,false,'native multiple-faint outcomes retain a system continuation');assert.equal(result.knockoutGaugeCause,'base_battle_knockout');
  }
});
for(const rule of data.purple_attacks)for(const owner of [0,6])test(`${owner}: effect KO ${rule.skill} does not trigger on Purple ties, losses, disabled replacements or failed predicates`,()=>{
  for(const color of [2,3,4]){
    const f=fixture(owner,rule.skill,2);f.figure(f.enemy).skills=[skill(color===2?1009:color===3?1199:1122,color,color===2?2:color===3?10:0)];
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.deepEqual(result.pendingKnockoutTargets??[],[]);assert(!result.effectKnockoutPlan);
  }
  const f=fixture(owner,rule.skill,2);f.match.disabledSkills.set(owner,new Set([rule.skill]));const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(result.attackerSkill.color,0);assert(!result.effectKnockoutPlan);
  if(rule.skill===1112){const f=fixture(owner,1112,2),r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(r.winner,owner);assert.equal(r.effectKnockoutPlan.eligible,false);assert.deepEqual(r.pendingKnockoutTargets??[],[]);}
  if(rule.skill===1497)for(const id of [1001,900000099]){const f=fixture(owner,1497,1);f.figure(f.enemy).id=id;assert.deepEqual(f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0).pendingKnockoutTargets??[],[]);}
});
for(const owner of [0,6])test(`${owner}: Fissure uses all583 original aliases and the resolved opposing color controls Mirror Coat`,()=>{
  const f=fixture(owner,1497);
  for(const [id,row]of Object.entries(catalog.figures)){
    f.figure(f.enemy).id=Number(id);f.figure(f.enemy).name='not Flying';f.figure(f.enemy).type=8;
    const p=plan(f.match.record,f.match.positions,f.match.conditions,owner,f.enemy,skill(1497),skill(1199,1,50),f.match.turn,contract.fieldEdges);
    assert.equal(p.targets.length,row.playable&&![row.type0,row.type1].includes(12)?1:0,id);
  }
  f.figure(f.enemy).id=1002;
  for(const color of [0,1,2,3,4])assert.equal(plan(f.match.record,f.match.positions,f.match.conditions,owner,f.enemy,skill(1112),skill(1009,color,1),f.match.turn,contract.fieldEdges).targets.length,color===2?1:0);
});
for(const owner of [0,6])for(const ability of Object.keys(bindings).map(Number))test(`${owner}: effect protection ${ability} gates real KO, but never protects ordinary attack damage`,()=>{
  const f=protectedFixture(owner,ability);assert.equal(protectedBy(f).length,1);
  const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.deepEqual(result.effectKnockoutPlan.targets,[]);assert.deepEqual(result.pendingKnockoutTargets??[],[]);assert.equal(f.match.positions.get(f.enemy),f.enemy===0?15:11);
  const damage=protectedFixture(owner,ability);damage.figure(owner).skills=[skill(1199,1,100)];
  const ordinary=damage.service.applyBaseBattleOutcome(damage.match,owner,damage.enemy,0,0);assert.equal(ordinary.knockout,true);assert.equal(damage.match.positions.get(damage.enemy),damage.enemy===0?41:43);
});
for(const owner of [0,6])for(const ability of Object.keys(bindings).map(Number))test(`${owner}: effect protection ${ability} distinguishes target health, source health, Wait, own turn and field/team scope`,()=>{
  const f=protectedFixture(owner,ability);
  for(const condition of data.special_conditions){
    f.match.conditions.set(f.enemy,condition);f.match.waits.set(f.enemy,3);assert.equal(protectedBy(f).length,f.rule.healthy_target?0:1,condition);
  }
  f.match.conditions.set(f.enemy,'normal');assert.equal(protectedBy(f).length,1,'Wait is not one of the eight special conditions');
  if(f.holder!==f.enemy){for(const condition of data.special_conditions){f.match.conditions.set(f.holder,condition);assert.equal(protectedBy(f).length,1,'healthy clause targets protected figure');}}
  f.match.turn=f.match.turn==='black'?'white':'black';assert.equal(protectedBy(f).length,f.rule.owner_turn_only?0:1);
  f.match.turn=f.match.turn==='black'?'white':'black';
  for(const point of [-1,28+f.holder,40,41,42,43]){f.match.positions.set(f.holder,point);assert.equal(protectedBy(f).length,0);}
  const foreign=protectedFixture(owner,ability);foreign.figure(foreign.holder).pokepower=-1;foreign.figure(owner).pokepower=ability;assert.equal(protectedBy(foreign).length,0,'foreign source cannot protect opponent');
});
for(const owner of [0,6])test(`${owner}: own Attack self-KO differs from opponents-only protection; each target is filtered independently`,()=>{
  for(const ability of [1143,1381,1429,1476]){
    const f=fixture(owner,1044,3);f.figure(owner).pokepower=ability;f.figure(owner).id=bindings[ability];
    const r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.deepEqual(r.pendingKnockoutTargets,ability===1381?[0,6]:[f.enemy]);
  }
  const f=fixture(owner,1044,3);for(const p of [owner,f.enemy]){f.figure(p).pokepower=1429;f.figure(p).id=1620;}
  assert.deepEqual(f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0).pendingKnockoutTargets??[],[],'both independent Sturdy targets survive');
  f.match.conditions.set(owner,'panic');assert.deepEqual(f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0).pendingKnockoutTargets,[owner],'one unhealthy target can still be knocked out');
});
for(const owner of [0,6])test(`${owner}: typed protection checks every alias; Shelter requires adjacency and allied Dark emitters still match Diamond Aura`,()=>{
  for(const ability of [1276,1427,1428]){
    const f=protectedFixture(owner,ability);
    for(const [id,row]of Object.entries(catalog.figures)){f.figure(f.enemy).id=Number(id);assert.equal(protectedBy(f).length,row.playable&&[row.type0,row.type1].includes(f.rule.target_type)?1:0,`${ability}/${id}`);}
    if(f.rule.emitter_type===0){
      f.figure(f.enemy).id=1342;
      for(const [id,row]of Object.entries(catalog.figures)){f.figure(owner).id=Number(id);assert.equal(protectedBy(f).length,row.playable&&[row.type0,row.type1].includes(0)?1:0,`Dark/${id}`);}
      const ally=f.enemy+2;f.figure(ally).id=1008;f.match.positions.set(ally,f.enemy===0?22:0);assert.equal(protectedBy(f,f.enemy,ally).length,1,'no opposing-emitter qualifier is printed');
    }
  }
  const f=protectedFixture(owner,1143);f.match.positions.set(f.holder,f.enemy===0?27:5);assert.equal(protectedBy(f).length,0,'two steps is not adjacent');
});
for(const owner of [0,6])test(`${owner}: supported Rock Slide, Grass Knot and Tectonic Rage effect KOs honor protection without removing independent Wait`,()=>{
  const f=protectedFixture(owner,1429);f.figure(owner).skills=[skill(1140,1,50)];f.match.waits.set(f.enemy,2);
  const r=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(r.winner,-1);assert.deepEqual(r.pendingKnockoutTargets??[],[]);assert.equal(f.match.waits.get(f.enemy),3);assert.equal(f.match.conditions.get(f.enemy),'normal');
  const damaged=protectedFixture(owner,1429);damaged.figure(owner).skills=[skill(1140,1,100)];damaged.match.waits.set(damaged.enemy,2);assert.equal(damaged.service.applyBaseBattleOutcome(damaged.match,owner,damaged.enemy,0,0).knockout,true,'Rock Slide damage still knocks out');
  const grass=protectedFixture(owner,1429);grass.figure(owner).skills=[skill(1452,1,60)];grass.figure(grass.enemy).skills=[skill(1199,1,120)];
  const gr=grass.service.applyBaseBattleOutcome(grass.match,owner,grass.enemy,0,0);assert.equal(gr.effectKnockoutPrevented,true);assert.equal(gr.knockout,false);assert.deepEqual(gr.pendingKnockoutTargets??[],[],'preventing the replacement does not restore the replaced KO (derived)');
  const z=protectedFixture(owner,1429);z.figure(owner).skills=[skill(1715,2,1)];assert.equal(z.service.applyBaseBattleOutcome(z.match,owner,z.enemy,0,0).effectKnockoutPrevented,true);
});
for(const owner of [0,6])test(`${owner}: both Center destinations validate before either faint marker; duplicate/off-field inputs cannot become hidden KO moves`,()=>{
  for(let black=0;black<3;black++)for(let white=0;white<3;white++){
    const f=fixture(owner,1044,3);if(black>0)f.match.positions.set(1,41);if(black>1)f.match.positions.set(2,40);if(white>0)f.match.positions.set(7,43);if(white>1)f.match.positions.set(8,42);
    const before=new Map(f.match.positions);assert.deepEqual(f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0).pendingKnockoutTargets,[0,6]);assert.deepEqual(f.match.positions,before,'validated batch stays deferred until completion');
  }
  const blocked=fixture(owner,1044,3);blocked.match.positions.set(7,43);blocked.match.positions.set(8,42);blocked.match.positions.set(9,36);
  const points=new Map(blocked.match.positions),conditions=new Map(blocked.match.conditions);
  assert.throws(()=>blocked.service.applyBaseBattleOutcome(blocked.match,owner,blocked.enemy,0,0),/invalid_effect_knockout_disposition/);assert.deepEqual(blocked.match.positions,points);assert.deepEqual(blocked.match.conditions,conditions,'second team failure cannot leave first team faint');
  const overlap=fixture(owner,1044,3);overlap.match.positions.set(owner+1,overlap.match.positions.get(owner));assert.throws(()=>overlap.service.applyBaseBattleOutcome(overlap.match,owner,overlap.enemy,0,0),/invalid_effect_knockout_disposition/);
});
