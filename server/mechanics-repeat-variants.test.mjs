import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CustomMatchService,customMatchTestHooks as rules} from './custom-match-engine.mjs';
const masters=JSON.parse(fs.readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).skill_masters;
const catalog=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const description='Spin again until %ワザ does not land - damage is multiplied by the number of %ワザ spins.';
const ids=Object.values(masters).filter(master=>master.format_type===3&&master.description===description).map(master=>master.skill_master_id).sort((a,b)=>a-b);
test('every plain repeated-hit FormatType3 ID is explicitly verified',()=>{
  assert.deepEqual(ids,[1168,1172,1201,1261,1273,1310,1361,1369,1596]);
});
for(const id of ids) test(`every original wheel variant of ${id} ${masters[id].name}: both actors, repeat and termination`,()=>{
  const variants=catalog.entries.find(entry=>entry.key===`skill:${id}`).variants;assert(variants.length);
  for(const variant of variants) for(const actor of [0,6]) for(const extra of [0,1,5]) {
    const service=new CustomMatchService({port:0});const match=service.createMatch('isolated-repeat-variants');
    const pokemon=match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===actor);
    assert(variant.range>0&&variant.range<96);
    pokemon.pokepower=-1;pokemon.skills=[{id,color:variant.color,range:variant.range,speed_or_damage:variant.power},
      {id:1131,color:0,range:96-variant.range,speed_or_damage:0}];
    const units=[0,...Array(extra).fill(variant.range-1),variant.range],supplied=[...units];
    const rolled=rules.rollBattleWheel(match,actor,(range,index)=>{assert.equal(range,96);assert.equal(index,actor);return supplied.shift();});
    assert.equal(supplied.length,0);assert.deepEqual(rolled.results.map(r=>r.num),units);
    assert.deepEqual(rolled.results.map(r=>r.type),['battle',...Array(extra+1).fill('probability')]);
    const selected=rules.selectedSpinSkill(match,actor,rolled.results);
    assert.equal(selected.id,id);assert.equal(selected.speed_or_damage,variant.power*(extra+1));
    assert.equal(selected.repeat_extra_hits,extra);
  }
});

test('disabled initial repeated attack resolves Miss with no extra draw',()=>{
  const service=new CustomMatchService({port:0}),match=service.createMatch('isolated-disabled-repeat');
  const pokemon=match.record.players[0].pokemons[0];pokemon.pokepower=-1;
  pokemon.skills=[{id:1261,color:1,range:64,speed_or_damage:60},{id:1131,color:0,range:32,speed_or_damage:0}];
  match.disabledSkills.set(0,new Set([1261]));let draws=0;
  const spin=rules.rollBattleWheel(match,0,()=>{draws++;return 0;});
  assert.equal(draws,1);assert.equal(spin.results.length,1);
  const selected=rules.selectedSpinSkill(match,0,spin.results);assert.equal(selected.id,1131);assert.equal(selected.speed_or_damage,0);
});

test('secondary probability-only spin never becomes a battle attack',()=>{
  const match=new CustomMatchService({port:0}).createMatch('isolated-probability-only');
  assert.equal(rules.selectedSpinSkill(match,0,[{displace:0,num:0,type:'probability'}]),null);
});

test('invalid or nonterminating RNG fails instead of inventing a terminal spin',()=>{
  const match=new CustomMatchService({port:0}).createMatch('isolated-invalid-repeat');
  match.record.players[0].pokemons[0].skills=[{id:1261,color:1,range:90,speed_or_damage:60},{id:1131,color:0,range:6,speed_or_damage:0}];
  for(const unit of [NaN,Infinity,-1,96,0.5,undefined]) assert.throws(()=>rules.rollBattleWheel(match,0,()=>unit),/invalid_spin_rng_result/);
  assert.throws(()=>rules.rollBattleWheel(match,0,()=>0),/repeated_spin_resource_limit/);
  assert.deepEqual(match.record.all_moves,[]);assert.equal(match.positions.get(0),28);
});

test('200 seeded repeated-hit sequences preserve every draw and independently counted damage',()=>{
  const match=new CustomMatchService({port:0}).createMatch('isolated-seeded-repeat');
  for(let seed=1;seed<=200;seed++) {
    const id=ids[seed%ids.length],range=8+(seed%80),power=10+(seed%200);let state=seed;
    match.record.players[0].pokemons[0].skills=[{id,color:1,range,speed_or_damage:power},{id:1131,color:0,range:96-range,speed_or_damage:0}];
    const draws=[];const spin=rules.rollBattleWheel(match,0,()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;const num=state%96;draws.push(num);return num;});
    assert.deepEqual(spin.results.map(r=>r.num),draws);
    const result=rules.selectedSpinSkill(match,0,spin.results);
    if(draws[0]>=range) {assert.equal(draws.length,1);assert.equal(result.id,1131);}
    else {assert(draws.at(-1)>=range);assert(draws.slice(0,-1).every(num=>num<range));assert.equal(result.id,id);assert.equal(result.speed_or_damage,power*(draws.length-1));}
  }
});

// These six IDs have separate native hit/miss controls, including the exact
// damage notice operand. A 100% wheel must still stop after its single retry.
for(const [id,addend,multiplier] of [[1283,50,1],[1301,20,1],[1307,50,1],[1492,50,1],[1533,50,1],[1676,0,2]]) {
  test(`single retry ${id}: all original variants and both identities`,()=>{
    const variants=catalog.entries.find(entry=>entry.key===`skill:${id}`).variants;assert(variants.length);
    for(const variant of variants) for(const actor of [0,6]) for(const hits of [false,true]) {
      const match=new CustomMatchService({port:0}).createMatch('isolated-single-retry');
      const pokemon=match.record.players.flatMap(p=>p.pokemons).find(p=>p.pokemon_index===actor);
      pokemon.pokepower=-1;
      pokemon.skills=[{id,color:variant.color,range:64,speed_or_damage:variant.power},{id:1131,color:0,range:32,speed_or_damage:0}];
      const supplied=[0,hits?63:64];
      const spin=rules.rollBattleWheel(match,actor,()=>{assert(supplied.length);return supplied.shift();});
      assert.equal(supplied.length,0);assert.deepEqual(spin.results.map(r=>r.type),['battle','probability']);
      const selected=rules.selectedSpinSkill(match,actor,spin.results);
      assert.equal(selected.id,id);assert.equal(selected.speed_or_damage,hits?variant.power*multiplier+addend:variant.power);
      pokemon.skills=[{id,color:variant.color,range:96,speed_or_damage:variant.power}];let draws=0;
      const full=rules.rollBattleWheel(match,actor,()=>{assert(++draws<=2);return 0;});
      assert.equal(draws,2);assert.equal(full.results.length,2);
      match.disabledSkills.set(actor,new Set([id]));draws=0;
      const disabled=rules.rollBattleWheel(match,actor,()=>{draws++;return 0;});
      assert.equal(draws,1);assert.equal(rules.selectedSpinSkill(match,actor,disabled.results).id,1131);
    }
  });
}
