import {nativeConditionChoices} from '../tests/native-condition-choice-cases.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {stonySphereHistoryCases} from '../tests/stony-sphere-history-cases.mjs';
import {CustomMatchService, customMatchTestHooks as hooks, customMatchContract} from './custom-match-engine.mjs';
import {sphereSources} from './sphere-plates.mjs';
const cases=stonySphereHistoryCases();
assert.equal(cases.length,104);
const snapshot=match=>structuredClone(Object.fromEntries(['record','plateState','positions','conditions','waits','triangles','battledAfterField','damageBonuses','disabledSkills','turns','turn','completedTurnLedger','pendingTouch','pendingPlate','pendingBattles','pendingSecondarySpins','pendingEntryGrudge','activeBattleDeclaration','battleResolutionPending'].map(k=>[k,match[k]])));
function checkTransit(service,match,c,errors){
  const expected=c.route_advertised,action=c.transit_action;
  const routes=hooks.legalRoutes(match,action.selective_side);
  assert.equal(routes.some(a=>a.value.route.join(',')===action.value.route.join(',')),expected,'native occupied-transit candidate');
  assert(routes.every(a=>![...match.positions.values()].includes(a.value.route.at(-1))),'all ordinary MP endpoints are empty');
  const recipientRoutes=routes.filter(a=>a.value.route[0]===action.value.route[0]).map(a=>a.value.route.join(',')).sort();
  assert.deepEqual(recipientRoutes,c.recipient_routes.map(r=>r.join(',')).sort(),'complete native recipient route set, including free cap controls');
  assert.equal(routes.some(a=>a.value.route.join(',')===c.cap_control_route.join(',')),c.cap_control_advertised,'independent native MP cap route');
  const occupied=c.before_transit.pokemon_conditions.find(p=>p.pokemon_index!==c.mover&&p.index>=0&&p.index<28).index;
  assert([...match.positions.values()].includes(occupied),'occupied endpoint fixture');
  const invalid=[{...structuredClone(action),value:{...action.value,route:[action.value.route[0],occupied]}}];
  if(!expected)invalid.push(structuredClone(action));
  for(const bad of invalid){const before=snapshot(match);service.acceptPlayerMove(match,bad,bad.selective_side);assert.equal(errors.length,1,'actual intake rejects blocked passage/occupied endpoint');errors.pop();assert.deepEqual(snapshot(match),before,'invalid MP retains complete authoritative observables');}
}

for(const c of cases)test(`native Stony legal history ${c.name}`,t=>{
  t.mock.method(globalThis,'setTimeout',()=>({unref(){}}));
  const conditionChoices=nativeConditionChoices(c);
  const errors=[],queues=new Map(),service=new CustomMatchService({port:0,clockSource:()=>0,conditionChoiceSource:(maximum,pokemon)=>{const choice=conditionChoices.shift();assert(choice,'recorded native condition choice');assert.equal(maximum,choice.maximum);assert.equal(pokemon,choice.pokemon);return choice.index;},spinUnitSource:(range,p)=>{
    const unit=queues.get(p)?.shift();assert(Number.isInteger(unit)&&unit>=0&&unit<range,'only recorded native wheel results');return unit;
  }});
  const outcomes=[],resolve=service.applyBaseBattleOutcome.bind(service);
  service.applyBaseBattleOutcome=(...args)=>{const result=resolve(...args);outcomes.push(result);return result};
  service.playOpponentTurn=()=>{};service.rejectPlayerMove=(_m,e)=>{errors.push(e);return false};
  const match=service.createMatch('isolated-native-stony-sphere-history');match.record=structuredClone(c.record);match.turn=c.initial_status.turn;match.phase='started';match.socket={destroyed:false,write(){},destroy(e){errors.push(e?.message)}};t.after(()=>{match.phase='finished'});
  service.preflightTurnRecord(match);
  const transitIndex=c.transit_action?c.steps.findIndex(st=>st.action.value.type==='mp_move'&&st.action.value.route.join(',')===c.transit_action.value.route.join(',')):-1;
  for(const [index,step] of c.steps.entries()){
    if(c.transit_action&&index===transitIndex)checkTransit(service,match,c,errors);
    const start=match.record.all_moves.length;
    if(step.action.value.type==='declare_plate'&&[5377,5378,5379,5380,5386,5404,5412,5416,5426,5445].includes(step.action.value.plate_id)){
      const plateId=step.action.value.plate_id;
      const targets=step.legal_before.filter(m=>m.value.type==='declare_plate'&&m.value.plate_id===plateId).map(m=>m.value.value.pokemon);
      for(let p=0;p<12;p++)assert.equal(hooks.validatePlateMove(match,step.action.selective_side,{selective_side:step.action.selective_side,value:{type:'declare_plate',plate_id:plateId,value:{type:'select_pokemon_and_declare_aura',pokemon:p}}}),targets.includes(p),'native Sphere target set');
      const invalid=[...Array.from({length:12},(_,p)=>p).filter(p=>!targets.includes(p)),-1,12,true,String(targets[0]),0.5];
      for(const pokemon of invalid){
        const bad=structuredClone(step.action);bad.value.value.pokemon=pokemon;
        const before=structuredClone({record:match.record,plates:match.plateState,positions:match.positions,conditions:match.conditions,turn:match.turn,ledger:match.completedTurnLedger});
        service.acceptPlayerMove(match,bad,bad.selective_side);assert.equal(errors.length,1,'invalid target rejected by actual intake');errors.pop();
        assert.deepEqual({record:match.record,plates:match.plateState,positions:match.positions,conditions:match.conditions,turn:match.turn,ledger:match.completedTurnLedger},before,'invalid Sphere leaves complete authoritative state unchanged');
      }
    }
    if(step.action.value.type==='spin'){
      for(const s of step.action.value.spins)queues.set(s.pokemon,s.results.map(r=>r.num));
      if(step.action.value.spins.every(s=>s.results.every(r=>r.type==='probability'))){
        assert(match.pendingSecondarySpins);assert.equal(service.performSecondarySpins(match,match.pendingSecondarySpins),true);
      }else{
        const declaration=match.record.all_moves.findLast(m=>m.value.type==='declare_battle');
        service.performBattleSpin(match,declaration.value.from_pokemon,declaration.value.to_pokemon,declaration.selective_side,match.activeBattleDeclaration);
      }
      assert.deepEqual(match.record.all_moves.filter(m=>m.value.type==='spin').at(-1).value,step.action.value,'native exact Spin wire order');
      assert([...queues.values()].every(q=>q.length===0));
      const result=step.effects.find(e=>e.value.type==='battle_result')?.value;
      if(result)assert.deepEqual([outcomes.at(-1).attackerSkill.speed_or_damage,outcomes.at(-1).defenderSkill.speed_or_damage],[result.attack.speed_or_damage,result.defence.speed_or_damage],'native Sphere damage on actual resolver');
      if(result&&c.condition_skill===1769)assert.deepEqual(outcomes.at(-1).purpleConditionPlan.condition_targets,step.effects.find(e=>e.value.type==='put_circle').value.pokemons,'original1769 ordered targets on the actual server resolver');
      if(result)for(const [pokemon,skill] of [[result.attack.pokemon,outcomes.at(-1).attackerSkill],[result.defence.pokemon,outcomes.at(-1).defenderSkill]]){
        const expected=step.effects.map(e=>e.value).filter(e=>e.type==='plate_damage_notice'&&[5377,5380].includes(e.plate_id)&&e.pokemon===pokemon).map(e=>({plate_id:e.plate_id,current:e.value.current,addend:e.value.addend,result:e.value.result}));
        assert.deepEqual(skill.sphere_damage??[],expected,'native ordered Sphere arithmetic in actual authoritative resolver');
      }
      const declares=step.effects.filter(e=>e.value.type==='declare_spin');
      if(declares.length)assert.deepEqual(match.pendingSecondarySpins.outcome.secondarySpins.map(p=>p.targets),declares.map(e=>e.value.pokemons),'native spatial declaration order');
      else assert.equal(match.pendingSecondarySpins,null);
    }else if(step.action.value.type==='disable_skill'){
      const declaration=match.record.all_moves.findLast(m=>m.value.type==='declare_battle');
      service.resolveBattle(match,declaration,match.activeBattleDeclaration);
      assert.deepEqual(match.record.all_moves.slice(start).map(m=>({selective_side:m.selective_side,value:m.value})),[step.action],'real resolver emits the native forced wheel-disable action');
      assert.deepEqual([...match.disabledSkills.get(step.action.value.pokemon)],step.action.value.skill_id,'authoritative wheel exclusion');
    }else service.acceptPlayerMove(match,structuredClone(step.action),step.action.selective_side);
    assert.deepEqual(errors,[],`history action ${index} accepted`);assert.equal(match.turn,step.status.turn);
    if(step.status.selective_side==='both')assert(match.battleResolutionPending);else assert.equal(service.selectionSide(match),step.status.selective_side);
    for(const p of step.status.pokemon_conditions)assert.deepEqual([match.positions.get(p.pokemon_index),match.conditions.get(p.pokemon_index),match.triangles.get(p.pokemon_index),match.waits.get(p.pokemon_index),match.battledAfterField.get(p.pokemon_index)],[p.index,p.marker.circle,p.marker.triangle,p.wait,p.marker.battled_after_field_in],`${c.name}/${index} native figure ${p.pokemon_index}`);
    assert.deepEqual(hooks.plateStateSnapshot(match).plate_conditions,step.status.plate_conditions,'every equipped copy retains native aura/used/unused state');
    for(const p of step.status.pokemon_conditions)assert.equal(hooks.plateStateSnapshot(match).attachments.some(a=>a.pokemon===p.pokemon_index&&a.effect.charge_effect),Boolean(p.effect.charge_effect),'native source charge attachment '+p.pokemon_index);
    for(const plateId of [5377,5378,5379,5380,5386,5404,5412,5416])for(const p of step.status.pokemon_conditions)assert.equal(sphereSources(match.record,match.positions,match.plateState,p.pokemon_index,plateId,customMatchContract.fieldEdges).length>0,(p.effect.ids.plates??[]).includes(plateId),'native derived aura membership '+plateId+'/'+p.pokemon_index);
    for(const p of step.status.pokemon_conditions)assert.equal(match.plateState.attachments.some(a=>a.plate_id===5445&&a.pokemon===p.pokemon_index),(p.effect.ids.plates??[]).includes(5445),'native Frost holder-only membership '+p.pokemon_index);
    assert.equal(new Set(match.positions.values()).size,12);assert.equal(service.completedTurnCheckpoint(match).checkpoint.state.completed_turns,300-step.status.remaining_turns);
    assert.deepEqual(match.record.all_moves.slice(start).filter(m=>m.value.type==='add_z_gauge').map(m=>m.value),step.effects.filter(e=>e.value.type==='add_z_gauge').map(e=>e.value),'native ordered gauge receipts');
  }
  if(c.transit_action&&transitIndex<0)checkTransit(service,match,c,errors);
  assert.equal(conditionChoices.length,0,'every recorded condition choice consumed');assert.equal(match.battleResolutionPending,false);assert.equal(match.pendingSecondarySpins,null);assert.equal(match.pendingJump,null);
  if(c.scenario==='same-holder')assert.equal(hooks.validatePlateMove(match,match.turn,{selective_side:match.turn,value:{type:'declare_plate',plate_id:5404,value:{type:'select_pokemon_and_declare_aura',pokemon:c.owner}}}),false,'native existing holder cannot receive duplicate Sphere');
});
