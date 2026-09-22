import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CustomMatchService} from './custom-match-engine.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../docs/generated/mechanics-20260913/coverage.json',import.meta.url)));
const masters=JSON.parse(fs.readFileSync(new URL('../data/figure_master_map.json',import.meta.url))).skill_masters;
const groups=[['panic',[1009,1063,1070]],['sleep',[1018,1039,1064,1085,1318]],['burn',[1023,1024,1106]],
  ['paralyze',[1045,1071,1103]],['poison',[1073,1074,1077,1078]],['bad_poison',[1075,1076]],['freeze',[1319]]];
const effects=[[1020,'sleep'],...groups.flatMap(([status,ids])=>ids.map(id=>[id,status]))];
test('every identical-description Purple FormatType0 status master is mapped explicitly',()=>{
  for(const [status,ids] of groups) {
    const original=masters[ids[0]];
    assert.deepEqual(Object.values(masters).filter(m=>m.skill_color===2&&m.format_type===0&&m.description===original.description).map(m=>m.skill_master_id).sort((a,b)=>a-b),ids,status);
  }
});
// Wheel variants retain their actual range and stars. Ability and status
// immunity are deliberately neutral here and need their separate controls.
for(const [id,status] of effects) test(`purple ${id}: every original wheel range/star variant, both identities and all attack colors`,()=>{
  const entry=catalog.entries.find(row=>row.key===`skill:${id}`);assert(entry.variants.length);
  for(const variant of entry.variants) for(const actor of [0,6]) for(const color of [0,1,2,3,4]) for(const initialMiss of [false,true]) {
    assert.equal(variant.color,2);assert(variant.range>0&&variant.range<96);assert(variant.stars>0);
    const service=new CustomMatchService({port:0}),match=service.createMatch('isolated-purple-variant');
    const enemy=actor===0?6:0,figures=match.record.players.flatMap(p=>p.pokemons);
    for(const figure of figures) figure.pokepower=-1;
    figures.find(p=>p.pokemon_index===actor).skills=[{id,color:2,range:variant.range,speed_or_damage:variant.stars},{id:1131,color:0,range:96-variant.range,speed_or_damage:0}];
    const opposing=[{id:1131,power:0},{id:1199,power:100},{id:1085,power:2},{id:1003,power:100},{id:1122,power:0}][color];
    figures.find(p=>p.pokemon_index===enemy).skills=[{id:opposing.id,color,range:96,speed_or_damage:opposing.power}];
    match.positions.set(0,15);match.positions.set(6,11);
    service.applyBaseBattleOutcome(match,actor,enemy,initialMiss?variant.range:variant.range-1,0);
    const success=!initialMiss&&(color<2||(color===2&&variant.stars>2));
    assert.equal(match.conditions.get(enemy),success?status:'normal');
    const opposingSleep=color===2&&(initialMiss||variant.stars<2);
    assert.equal(match.conditions.get(actor),opposingSleep||(success&&id===1020)?'sleep':'normal');
    assert.equal(new Set(match.positions.values()).size,12);
  }
});
