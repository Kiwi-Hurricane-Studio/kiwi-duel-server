import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CustomMatchService,customMatchContract} from './custom-match-engine.mjs';
import {benchAttackPlan,benchMovementProtectionSources} from './bench-attacks.mjs';
import {zSkillCatalog} from './z-skill-catalog.mjs';
const read=file=>JSON.parse(fs.readFileSync(new URL(file,import.meta.url)));
const coverage=read('../docs/generated/mechanics-20260913/coverage.json');
const primary=read('../docs/generated/mechanics-20260913/native-multispin.json').cases.find(e=>e.name.endsWith('purple-primary-1018'));
const edges=customMatchContract.fieldEdges;
test('bench target scopes bind to explicit original Purple IDs; equal descriptions on Gold or unlinked text do not create handlers',()=>{
  const rules=read('../data/bench_attack_rules.json'),masters=read('../data/figure_master_map.json').skill_masters;
  assert.deepEqual(rules.attacks.map(r=>r.id),[1027,1052,1098,1329,1467,1499,1630]);
  for(const rule of rules.attacks)assert.equal(masters[rule.id].skill_color,2);
  assert.equal(masters[1052].description,'All neighbor Pokémon are moved to the bench and gain Wait.');
  assert.equal(masters[1467].description,'This Pokémon moves to the bench and gains Wait.');
  assert.equal(masters[1630].description,'Moves the battle opponent to the bench. The battle opponent and all opposing Flying-type Pokémon on the field gain Wait 3.');
  assert.equal(masters[1467].next_field_id,1);assert.equal(masters[1631].skill_color,3);
  const f=fixture(0,1467);
  assert.equal(benchAttackPlan(f.match.record,f.match.positions,0,6,attack(1631,3),edges),null);
  assert.equal(benchAttackPlan(f.match.record,f.match.positions,0,6,attack(1062,2),edges),null);
  const localization=read('../docs/generated/battle-route-20260906/candidate-boot-cache-audit.json').resources.localization_phase_1;
  assert(localization.some(row=>row.text_key==='FigureMaster.TypeName.12'&&row.text==='Flying'));f.match.phase='finished';
});
const attack=(id=1199,color=1,range=96,power=100)=>({id,color,range,speed_or_damage:power});
function fixture(owner,id) {
  const service=new CustomMatchService({port:0}),match=service.createMatch('bench-scope-isolated'),enemy=owner===0?6:0;
  const figures=match.record.players.flatMap(p=>p.pokemons);
  for(const p of figures){p.pokepower=-1;p.id=1002;p.skills=[attack()];}
  const emitter=figures.find(p=>p.pokemon_index===owner),target=figures.find(p=>p.pokemon_index===enemy);
  emitter.skills=[attack(id,2,96,{1052:1,1467:3,1630:2}[id])];
  match.positions.set(0,15);match.positions.set(6,11);
  const figure=pokemon=>figures.find(p=>p.pokemon_index===pokemon);
  return {service,match,owner,enemy,figures,emitter,target,figure};
}
for(const id of [1052,1467,1630])test(`bench scope ${id}: every original variant, both owners, all colors, star loss/tie/win and initial Miss`,()=>{
  const entry=coverage.entries.find(e=>e.key===`skill:${id}`);assert(entry.variants.length);
  for(const v of entry.variants)for(const owner of [0,6])for(const color of [0,1,2,3,4])for(const stars of [v.stars-1,v.stars,v.stars+1])for(const miss of [false,true]) {
    const f=fixture(owner,id);f.emitter.skills=[attack(id,2,v.range,v.stars),attack(1131,0,96-v.range,0)];
    f.target.skills=[attack([1131,1199,1085,1003,1122][color],color,96,color===2?stars:color===1||color===3?100:0)];
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,miss?v.range:v.range-1,0);
    const success=!miss&&(color<2||color===2&&v.stars>stars),moved=id===1467?owner:f.enemy;
    assert.equal(!!result.benchTransfer,success);
    if(success){assert.equal(result.knockout,false);assert.equal(f.match.positions.get(moved),28+moved);assert.equal(f.match.waits.get(moved),id===1630?3:2);}
    else assert(![owner,f.enemy].some(p=>f.match.positions.get(p)===28+p),'no bench on failure; ordinary damage KO may still occur');
    assert.equal(new Set(f.match.positions.values()).size,12);f.match.phase='finished';
  }
});
test('Storm includes adjacent allies and enemies, excludes self and distance-two figures, and clears all special conditions',()=>{
  for(const owner of [0,6])for(const allied of [false,true])for(const condition of ['bad_poison','burn','freeze','melt','panic','paralyze','poison','sleep']) {
    const f=fixture(owner,1052),near=allied?owner+1:f.enemy+1;
    f.match.positions.set(near,owner===0?20:6);f.match.positions.set(owner+2,owner===0?27:5);
    f.target.skills=[attack(1131,0,96,0)];
    for(const p of [near,f.enemy]){f.match.conditions.set(p,condition);f.match.waits.set(p,5);f.match.battledAfterField.set(p,true);f.match.disabledSkills.set(p,new Set([1199]));}
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
    assert.deepEqual(result.benchTransfer.transfers.map(t=>t.pokemon),[near,f.enemy].sort((a,b)=>a-b));
    for(const p of [near,f.enemy]){assert.equal(f.match.positions.get(p),28+p);assert.equal(f.match.conditions.get(p),'normal');assert.equal(f.match.waits.get(p),2);assert.equal(f.match.battledAfterField.get(p),false);assert.equal(f.match.disabledSkills.has(p),false);}
    assert.equal(f.match.positions.get(owner),owner===0?15:11);assert.equal(f.match.waits.get(owner),0);assert.equal(f.match.positions.get(owner+2),owner===0?27:5);
    f.match.phase='finished';
  }
});
test('Storm plans all canonical field adjacencies before mutation, with deterministic target order',()=>{
  for(const source of Array.from({length:28},(_,i)=>i))for(const owner of [0,6]) {
    const neighbors=edges.flatMap(([a,b])=>a===source?[b]:b===source?[a]:[]).filter(p=>p<28);
    if(!neighbors.length)continue;
    const f=fixture(owner,1052);f.match.positions.set(owner,source);f.match.positions.set(f.enemy,neighbors[0]);
    for(const [index,point]of neighbors.slice(1).entries())f.match.positions.set(owner+1+index,point);
    const plan=benchAttackPlan(f.match.record,f.match.positions,owner,f.enemy,f.emitter.skills[0],edges);
    assert.deepEqual(plan.transfers.map(t=>t.from).sort((a,b)=>a-b),[...neighbors].sort((a,b)=>a-b));
    assert.deepEqual(plan.transfers.map(t=>t.pokemon),plan.wait_targets);
    assert.equal(f.match.positions.get(owner),source,'planning is read-only');f.match.phase='finished';
  }
});
test('a later occupied Storm bench destination aborts the entire transaction before cleanup or Wait',()=>{
  const f=fixture(0,1052);f.match.positions.set(1,20);f.match.positions.set(7,34);f.match.conditions.set(1,'sleep');f.match.waits.set(1,5);
  const snapshot=()=>JSON.stringify([f.match.positions,f.match.conditions,f.match.waits,f.match.battledAfterField,f.match.disabledSkills].map(m=>[...m]));
  const before=snapshot();assert.throws(()=>f.service.applyBaseBattleOutcome(f.match,0,6,0,0),/occupied_bench_attack_destination/);assert.equal(snapshot(),before);
  f.match.phase='finished';
});
test('Hurricane Wait3 includes a non-Flying opponent plus all opposing Flying figures on field, with exact original type identities',()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,1630),other=f.figure(f.enemy+1),ally=f.figure(owner+1);
    f.match.positions.set(f.enemy+1,owner===0?6:20);f.match.positions.set(owner+1,owner===0?20:6);ally.id=1001;
    for(const rule of Object.values(zSkillCatalog().rules).filter(r=>r.playable)) {
      other.id=rule.rule_poke_id;
      const plan=benchAttackPlan(f.match.record,f.match.positions,owner,f.enemy,f.emitter.skills[0],edges);
      assert.deepEqual(plan.wait_targets,([rule.type0,rule.type1].includes(12)?[f.enemy,f.enemy+1]:[f.enemy]).sort((a,b)=>a-b),String(rule.rule_poke_id));
      assert.deepEqual(plan.transfers.map(t=>t.pokemon),[f.enemy],'Flying figures receive Wait, not an extra bench transfer');
    }
    other.id=1001;f.target.id=1002;f.match.conditions.set(f.enemy+1,'poison');
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(result.knockout,false);
    assert.equal(f.match.waits.get(f.enemy),3);assert.equal(f.match.waits.get(f.enemy+1),3);assert.equal(f.match.waits.get(owner+1),0);
    assert.equal(f.match.positions.get(f.enemy),28+f.enemy);assert.equal(f.match.positions.get(f.enemy+1),owner===0?6:20);assert.equal(f.match.conditions.get(f.enemy+1),'poison');
    f.match.positions.set(f.enemy,owner===0?11:15);
    for(const point of [28+f.enemy+1,owner===0?43:41,44]){f.match.positions.set(f.enemy+1,point);assert.deepEqual(benchAttackPlan(f.match.record,f.match.positions,owner,f.enemy,f.emitter.skills[0],edges).wait_targets,[f.enemy]);}
    f.match.phase='finished';
  }
});
test('self-return ignores protection from other Attacks; battle-opponent-only protection does not protect a Storm bystander',()=>{
  for(const owner of [0,6])for(const ability of [1007,1018,1226,1307,1310,1372,1425,1426]) {
    const f=fixture(owner,1467);f.emitter.pokepower=ability;
    f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(f.match.positions.get(owner),28+owner);assert.equal(f.match.waits.get(owner),2);f.match.phase='finished';
  }
  for(const owner of [0,6])for(const ability of [1018,1425,1426]) {
    const f=fixture(owner,1052),neighbor=f.enemy+1;f.match.positions.set(neighbor,owner===0?20:6);f.figure(neighbor).pokepower=ability;
    f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
    assert.equal(f.match.positions.get(neighbor),ability===1018?(owner===0?20:6):28+neighbor);assert.equal(f.match.waits.get(neighbor),2);f.match.phase='finished';
  }
});
for(const ability of [1425,1426])test(`trap ${ability}: both opposing clauses use ability-owner perspective, including self-return and allied Storm`,()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,1467);f.target.pokepower=ability;
    assert.deepEqual(benchMovementProtectionSources(f.match.record,f.match.positions,owner,owner,f.enemy,edges),[{pokemon:f.enemy,pokepower:ability,scope:'adjacent_opposing_team'}]);
    f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);assert.equal(f.match.positions.get(owner),owner===0?15:11);assert.equal(f.match.waits.get(owner),2);
    for(const point of [28+f.enemy,owner===0?43:41,44]){f.match.positions.set(f.enemy,point);assert.deepEqual(benchMovementProtectionSources(f.match.record,f.match.positions,owner,owner,f.enemy,edges),[]);}
    f.match.positions.set(f.enemy,owner===0?6:20);assert.deepEqual(benchMovementProtectionSources(f.match.record,f.match.positions,owner,owner,f.enemy,edges),[],'distance two does not trap');
    f.match.positions.set(f.enemy,owner===0?11:15);f.emitter.pokepower=ability;f.target.pokepower=-1;
    assert.deepEqual(benchMovementProtectionSources(f.match.record,f.match.positions,owner,f.enemy,f.enemy,edges),[],'trap owner can still move the opposing target with its own Attack');
    f.match.phase='finished';
  }
});
test('Storm preserves an adjacent ally trapped by an opposing bystander outside the Storm radius',()=>{
  for(const owner of [0,6]) {
    const f=fixture(owner,1052),ally=owner+1,trap=f.enemy+1;
    f.match.positions.set(owner,6);f.match.positions.set(f.enemy,11);f.match.positions.set(ally,5);f.match.positions.set(trap,4);f.figure(trap).pokepower=1426;
    assert(edges.some(([a,b])=>[a,b].includes(5)&&[a,b].includes(4)));
    const result=f.service.applyBaseBattleOutcome(f.match,owner,f.enemy,0,0);
    assert.equal(f.match.positions.get(ally),5);assert.equal(f.match.waits.get(ally),2);
    assert.equal(f.match.positions.get(trap),4,'trap source is outside the Storm radius');
    assert(result.benchTransfer.transfers.find(t=>t.pokemon===ally).protection_sources.some(s=>s.pokemon===trap));f.match.phase='finished';
  }
});
test('participant existence and field positions are required even when self-return selects a different target',()=>{
  const f=fixture(0,1467);f.match.positions.set(6,34);
  assert.throws(()=>benchAttackPlan(f.match.record,f.match.positions,0,6,f.emitter.skills[0],edges),/invalid_bench_attack_target/);
  f.match.positions.set(6,11);f.match.record.players[0].pokemons=f.match.record.players[0].pokemons.filter(p=>p.pokemon_index!==0);
  assert.throws(()=>benchAttackPlan(f.match.record,f.match.positions,0,6,f.emitter.skills[0],edges),/invalid_bench_attack_target/);f.match.phase='finished';
});
async function until(predicate,label){for(let i=0;i<250;i++){if(predicate())return;await delay(5);}assert.fail(label);}
for(const owner of [0,6])test(`self-return owner ${owner}: accepted second battle preserves Blackout history when Purple suppresses Ice Shard`,async()=>{
  const enemy=owner===0?6:0,side=owner===0?'black':'white',opposite=owner===0?'white':'black';
  const queues=new Map([[owner,[0,48]],[enemy,[0,48]]]);let pending=null;
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:(_,p)=>queues.get(p)?.shift()});
  service.playOpponentTurn=()=>{};service.scheduleSecondarySpins=(_,p)=>pending=p;const outcomes=[];const base=service.applyBaseBattleOutcome.bind(service);service.applyBaseBattleOutcome=(...args)=>{const out=base(...args);outcomes.push(out);return out};const rejected=[];service.rejectPlayerMove=(_,r)=>rejected.push(r);
  const match=service.createMatch('self-bench-second-history');match.record=structuredClone(primary.record);match.record.all_moves=[];match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const p of match.record.players.flatMap(p=>p.pokemons)) {
    p.pokepower=-1;p.skills=[attack()];
    if(p.pokemon_index===owner){p.pokepower=1326;p.skills=[attack(1199,1,48,100),attack(1467,2,48,3)];}
    if(p.pokemon_index===enemy){p.pokepower=1001;p.skills=[attack(1199,1,48,100),attack(1001,1,48,100)];}
  }
  const accept=action=>{service.acceptPlayerMove(match,action,action.selective_side);assert.deepEqual(rejected,[]);};
  try {
    for(const action of structuredClone(primary.record.all_moves.slice(0,-2)))accept(action);
    if(owner===0)accept({selective_side:'white',value:{type:'null_move'}});
    accept({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
    await until(()=>!match.battleResolutionPending,'first battle completed');assert.equal(match.battledAfterField.get(owner),true);assert.equal(match.waits.get(enemy),2);
    accept({selective_side:opposite,value:{type:'mp_move',route:owner===0?[35,0]:[29,21]}});
    accept({selective_side:side,value:{type:'mp_move',route:owner===0?[29,21]:[35,0]}});
    assert.equal(match.waits.get(enemy),0);
    accept({selective_side:opposite,value:{type:'declare_battle',from_pokemon:enemy,to_pokemon:owner}});
    await until(()=>!match.battleResolutionPending,'second battle completed');assert.equal(outcomes.at(-1).battledBefore[owner],true);assert.equal(match.battledAfterField.get(owner),false);
    assert.equal(pending,null);assert.deepEqual(outcomes.at(-1).secondarySpins,[]);assert.equal(service.performSecondarySpins(match,pending),false);
    assert.equal(match.waits.get(enemy),0,'same Purple battle cannot rearm Blackout');assert.equal(match.conditions.get(enemy),'normal');
    assert.equal(match.positions.get(owner),28+owner);assert.equal(match.waits.get(owner),1);assert([...queues.values()].every(q=>q.length===0));
  }finally{match.phase='finished';}
});
for(const owner of [0,6])for(const id of [1052,1467,1630])test(`accepted scoped bench ${id}, actor ${owner}: real movement, suppressed Ice Shard and one turn completion`,async()=>{
  const enemy=owner===0?6:0,side=owner===0?'black':'white',queues=new Map([[owner,[0]],[enemy,[0]]]);let pending=null;
  const service=new CustomMatchService({port:0,moveDelayMs:0,opponentTurnDelayMs:0,clockSource:()=>0,spinUnitSource:(_,p)=>queues.get(p)?.shift()});
  service.playOpponentTurn=()=>{};service.scheduleSecondarySpins=(_,p)=>pending=p;const outcomes=[];const base=service.applyBaseBattleOutcome.bind(service);service.applyBaseBattleOutcome=(...args)=>{const out=base(...args);outcomes.push(out);return out};const rejected=[];service.rejectPlayerMove=(_,r)=>rejected.push(r);
  const match=service.createMatch('scoped-bench-actions');match.record=structuredClone(primary.record);match.record.all_moves=[];match.phase='started';match.socket={destroyed:false,write:()=>{}};
  for(const p of match.record.players.flatMap(p=>p.pokemons)){p.pokepower=-1;p.skills=[attack()];if(p.pokemon_index===owner)p.skills=[attack(id,2,96,{1052:1,1467:3,1630:2}[id])];if(p.pokemon_index===enemy)p.skills=[attack(1001)];}
  const actions=structuredClone(primary.record.all_moves.slice(0,-2));
  if(owner===0)actions.push({selective_side:'white',value:{type:'null_move'}});
  actions.push({selective_side:side,value:{type:'declare_battle',from_pokemon:owner,to_pokemon:enemy}});
  try {
    for(const action of actions){service.acceptPlayerMove(match,action,action.selective_side);assert.deepEqual(rejected,[]);}
    await until(()=>!match.battleResolutionPending,'scoped Purple bench completed');const moved=id===1467?owner:enemy;
    assert.equal(match.positions.get(moved),28+moved);assert.equal(pending,null);assert.deepEqual(outcomes.at(-1).secondarySpins,[]);
    assert.equal(match.turn,side==='black'?'white':'black');assert.equal(match.waits.get(moved),id===1630?2:1);
    assert.equal(match.battledAfterField.get(moved),false);assert.equal(match.record.all_moves.filter(m=>m.value.type==='spin').length,1);
    assert.equal(service.performSecondarySpins(match,pending),false);assert([...queues.values()].every(q=>q.length===0));
  }finally{match.phase='finished';}
});
