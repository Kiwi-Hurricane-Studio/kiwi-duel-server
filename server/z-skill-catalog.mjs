// Public original master graph and bounded Z-choice derivation. Pure after the
// immutable catalog is loaded. This is not an effect handler or phase engine.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const bytes=readFileSync(new URL('../data/z_skill_catalog.json',import.meta.url));
const IMPLEMENTED_DESTINATIONS=Object.freeze([1715,1717]);
const requireValue=(ok,message)=>{if(!ok)throw new TypeError(message);};
const isId=value=>Number.isSafeInteger(value)&&value>0;
const isActor=value=>Number.isInteger(value)&&value>=0&&value<12;
const sideOf=value=>value<6?'black':'white';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lookup=(values,key)=>values instanceof Map?values.get(key):plain(values)&&Object.hasOwn(values,key)?values[key]:undefined;
const clone=value=>structuredClone(value);
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export function validateZSkillCatalog(data) {
  requireValue(data?.schema==='kiwi-duel-z-skill-catalog-1'&&data.source_revision===800,'invalid_z_catalog_schema');
  for(const name of ['figures','rules','type_mappings','z_skills','skill_masters']) {
    requireValue(plain(data[name]),'invalid_z_catalog_'+name);
    for(const key of Object.keys(data[name])) requireValue(/^(0|[1-9][0-9]*)$/.test(key),'noncanonical_z_catalog_id');
  }
  for(const [key,skill]of Object.entries(data.skill_masters)) {
    requireValue(Number(key)===skill.SkillMasterId&&isId(skill.SkillMasterId),'invalid_z_skill_master_id');
    for(const name of ['SkillColor','FormatType','AttackEffectId','DefenseTypeId','NextFieldId'])
      requireValue(Number.isSafeInteger(skill[name])&&skill[name]>=0,'invalid_z_skill_master_'+name);
    requireValue(skill.IsNull===false,'null_z_skill_master');
  }
  for(const [key,skill]of Object.entries(data.z_skills)) {
    const original=data.skill_masters[key];
    requireValue(original&&Number(key)===skill.SkillMasterId,'missing_z_destination_master');
    for(const name of ['SkillColor','FormatType','AttackEffectId','DefenseTypeId','NextFieldId'])
      requireValue(original[name]===skill[name],'conflicting_z_destination_master');
    requireValue(typeof skill.name==='string'&&typeof skill.description==='string','missing_z_destination_text');
  }
  for(const [key,row]of Object.entries(data.type_mappings))
    requireValue(Number(key)===row.type&&data.z_skills[row.z_skill_id],'invalid_z_type_mapping');
  for(const [key,figure]of Object.entries(data.figures)) {
    requireValue(Number(key)===figure.item_master_id&&Number.isSafeInteger(figure.rule_poke_id)&&figure.rule_poke_id>=0,'invalid_z_figure_identity');
    const rule=data.rules[figure.rule_poke_id];
    requireValue(rule&&rule.item_master_ids.includes(figure.item_master_id),'missing_z_rule_alias_join');
    for(const name of ['type0','type1','playable'])requireValue(figure[name]===rule[name],'ambiguous_z_alias_'+name);
    requireValue(JSON.stringify(figure.type_rows)===JSON.stringify(rule.type_rows)
      &&JSON.stringify(figure.special_z_mappings)===JSON.stringify(rule.special_z_mappings),'ambiguous_z_alias_mappings');
  }
  for(const [key,rule]of Object.entries(data.rules)) {
    requireValue(Number(key)===rule.rule_poke_id&&typeof rule.playable==='boolean','invalid_z_rule_identity');
    requireValue(Array.isArray(rule.item_master_ids)&&rule.item_master_ids.length>0
      &&new Set(rule.item_master_ids).size===rule.item_master_ids.length,'invalid_z_rule_aliases');
    for(const id of rule.item_master_ids)requireValue(data.figures[id]?.rule_poke_id===rule.rule_poke_id,'invalid_z_reverse_alias_join');
    requireValue(Array.isArray(rule.type_rows)&&Array.isArray(rule.special_z_mappings),'invalid_z_mapping_arrays');
    requireValue(new Set(rule.type_rows.map(row=>row.type)).size===rule.type_rows.length,'duplicate_z_type_mapping');
    for(const row of rule.type_rows)requireValue([rule.type0,rule.type1].includes(row.type)
      &&data.type_mappings[row.type]?.z_skill_id===row.z_skill_id&&data.z_skills[row.z_skill_id],'invalid_z_rule_type_join');
    for(const row of rule.special_z_mappings)requireValue(data.skill_masters[row.skill_id]&&data.z_skills[row.z_skill_id],'invalid_z_special_join');
  }
  return true;
}

/** A copied factory exists for isolated corruption/alias tests, not live master injection. */
export function createZSkillCatalog(data) {
  validateZSkillCatalog(data); const catalog=freeze(clone(data));
  const validWheel=pokemon=>Array.isArray(pokemon?.skills)&&pokemon.skills.length>0
    &&pokemon.skills.every(slot=>plain(slot)&&isId(slot.id)&&catalog.skill_masters[slot.id]
      &&Number.isInteger(slot.range)&&slot.range>0&&Number.isSafeInteger(slot.speed_or_damage)&&slot.speed_or_damage>=0)
    &&pokemon.skills.reduce((sum,slot)=>sum+slot.range,0)===96;
  function resolveRecordFigure(id) {
    if(!isId(id))return {ok:false,code:'invalid_record_figure_id'};
    const original=catalog.rules[id], item=catalog.figures[id];
    const candidates=new Set([original?.rule_poke_id,item?.rule_poke_id].filter(value=>value!==undefined));
    if(candidates.size!==1)return {ok:false,code:candidates.size?'ambiguous_record_figure_id':'unknown_record_figure_id',record_id:id};
    const rule=catalog.rules[[...candidates][0]];
    if(!rule?.playable)return {ok:false,code:'nonplayable_record_figure',record_id:id};
    return {ok:true,record_id:id,rule_id:rule.rule_poke_id,
      identity:original?'original_rule_poke_id':'verified_legacy_item_master_alias',rule:clone(rule)};
  }
  function powerFor(pokemon,destination) {
    const resolved=resolveRecordFigure(pokemon?.id);
    if(!resolved.ok)return resolved;
    if(!validWheel(pokemon))return {ok:false,code:'invalid_or_unsupported_z_record_wheel'};
    if(!catalog.z_skills[destination])return {ok:false,code:'unknown_z_destination'};
    if(!resolved.rule.type_rows.some(row=>row.z_skill_id===destination))
      return {ok:false,code:'z_special_or_unmapped_power_unproven'};
    // Only these Purple IDs have controlled native star/damage-independent4
    // receipts. The source Rock/Ground mapping generalization is explicit.
    if([1715,1717].includes(destination))return {ok:true,power:4,
      evidence:'native_rule1150_purple_fixed4',boundary:'source_type_mapping_generalization_beyond_controlled_rule1150'};
    const proven=(resolved.rule_id===1025&&destination===1692)
      ||(resolved.rule_id===1296&&[1718,1721].includes(destination));
    if(!proven)return {ok:false,code:'z_power_rule_not_proven'};
    let maximum=0;
    for(const slot of pokemon.skills??[]) {
      const master=catalog.skill_masters[slot.id];
      if(!master)return {ok:false,code:'unknown_record_skill_id'};
      if([1,3].includes(master.SkillColor)) {
        // Format0 positive damage remains an unanswered native contrast.
        if(master.FormatType!==1&&slot.speed_or_damage>0)return {ok:false,code:'z_positive_nondamage_format_unproven'};
        if(master.FormatType===1)maximum=Math.max(maximum,slot.speed_or_damage);
      }
    }
    if(!Number.isSafeInteger(maximum*2))return {ok:false,code:'z_power_overflow'};
    return {ok:true,power:maximum*2,evidence:'native_controlled_supplied_white_gold_max',
      boundary:'bounded_rule1025_or1296_positive_range_known_skill_wheels'};
  }
  /** Caller owns turn/phase/modifier guards. Missing state fails closed.
   * positions/waits/conditions accept Maps keyed global pokemon_index, or plain
   * snapshots with the same keys. Gauge uses {black,white}. Only explicitly
   * enrolled1715/1717 handlers are emitted; the legacy default stays1717-only.
   */
  function deriveZChoices(record,{side,gauges,positions,waits,conditions,phaseAllowed,supportedSkillIds=[1717]}={}) {
    const result={choices:[],diagnostics:[],source_mappings:[]};
    const note=(code,details={})=>result.diagnostics.push({code,...details});
    if(!['black','white'].includes(side)){note('invalid_z_side');return result;}
    if(phaseAllowed!==true){note('z_phase_not_allowed');return result;}
    if(!plain(gauges)||!['black','white'].every(s=>Number.isInteger(gauges[s])&&gauges[s]>=0&&gauges[s]<=100)){
      note('invalid_z_gauges');return result;
    }
    if(gauges[side]!==100){note('z_gauge_not_full');return result;}
    if(!Array.isArray(supportedSkillIds)||supportedSkillIds.some(id=>!isId(id))){note('invalid_z_supported_handlers');return result;}
    if(!Array.isArray(record?.players)||record.players.length!==2||record.players.some(p=>!plain(p))
      ||new Set(record.players.map(p=>p.color)).size!==2
      ||!record.players.every(p=>['black','white'].includes(p.color)&&Array.isArray(p.pokemons))){note('invalid_z_record_players');return result;}
    const definitions=record.players.flatMap(player=>player.pokemons.map(pokemon=>({pokemon,side:player.color})));
    if(definitions.some(row=>!plain(row.pokemon)||!isActor(row.pokemon.pokemon_index)||sideOf(row.pokemon.pokemon_index)!==row.side)
      ||new Set(definitions.map(row=>row.pokemon.pokemon_index)).size!==definitions.length){note('invalid_or_duplicate_z_actor_ids');return result;}
    for(const {pokemon}of definitions.filter(row=>row.side===side).sort((a,b)=>a.pokemon.pokemon_index-b.pokemon.pokemon_index)) {
      const actor=pokemon.pokemon_index, context={pokemon:actor,record_id:pokemon.id};
      const resolved=resolveRecordFigure(pokemon.id);
      if(!resolved.ok){note(resolved.code,context);continue;}
      context.rule_id=resolved.rule_id;
      result.source_mappings.push({...context,identity:resolved.identity,type_rows:resolved.rule.type_rows,special_rows:resolved.rule.special_z_mappings});
      const point=lookup(positions,actor), wait=lookup(waits,actor), condition=lookup(conditions,actor);
      if(!Number.isInteger(point)||!(point>=0&&point<=27||point===28+actor)){note('z_actor_not_on_field_or_own_bench',context);continue;}
      if(!Number.isInteger(wait)||wait<0){note('invalid_z_wait',context);continue;}
      if(wait!==0){note('z_actor_waiting',context);continue;}
      if(condition!=='normal'){note('z_condition_not_supported',context);continue;}
      if(!Number.isInteger(pokemon.mp)||pokemon.mp<=0){note('z_positive_supplied_mp_required',context);continue;}
      if(!validWheel(pokemon)){note('invalid_or_unsupported_z_record_wheel',context);continue;}
      if(resolved.rule.special_z_mappings.length)note('z_special_mapping_predicate_unproven',context);
      for(const destination of [...new Set(resolved.rule.type_rows.map(row=>row.z_skill_id))].sort((a,b)=>a-b)) {
        if(!IMPLEMENTED_DESTINATIONS.includes(destination)||!supportedSkillIds.includes(destination)){
          note('z_handler_not_supported',{...context,dst_skill_id:destination});continue;
        }
        const power=powerFor(pokemon,destination);
        if(!power.ok){note(power.code,{...context,dst_skill_id:destination});continue;}
        note(power.boundary,{...context,dst_skill_id:destination,evidence:power.evidence});
        result.choices.push({selective_side:side,value:{dst_skill_id:destination,pokemon:actor,speed_or_damage:power.power,type:'z_skill'}});
      }
    }
    return result;
  }
  function effectiveZSkill(active) {
    requireValue(active&&IMPLEMENTED_DESTINATIONS.includes(active.dst_skill_id)&&active.speed_or_damage===4,'unsupported_effective_z_skill');
    return {id:active.dst_skill_id,range:96,speed_or_damage:4,skill_master:clone(catalog.z_skills[active.dst_skill_id])};
  }
  return {resolveRecordFigure,deriveZChoices,deriveZPower:powerFor,effectiveZSkill,catalog:()=>clone(catalog)};
}

const loaded=createZSkillCatalog(JSON.parse(bytes));
export const resolveRecordFigure=loaded.resolveRecordFigure;
export const deriveZChoices=loaded.deriveZChoices;
export const deriveZPower=loaded.deriveZPower;
export const effectiveZSkill=loaded.effectiveZSkill;
export const zSkillCatalog=loaded.catalog;
export const Z_SKILL_CATALOG_IDENTITY=Object.freeze({schema:'kiwi-duel-z-skill-catalog-1',bytes:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex'),source_revision:800});
