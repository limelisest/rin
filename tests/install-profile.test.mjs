import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { applyRecommendedCodexProfile, migrateContextManagementConfig, removeObsoleteCodexSettings, RIN_OBSOLETE_CODEX_EDITS, RIN_RECOMMENDED_CODEX_EDITS } from '../dist/install/profile.js';

test('recommended profile batch-upserts only the reviewed keys',async()=>{
  let request;
  await applyRecommendedCodexProfile({codexHome:'/tmp/codex-home',writeConfig:async value=>{request=value;return{ok:true};}});
  assert.equal(request.filePath,undefined,'Codex selects the user config from CODEX_HOME');
  assert.equal(request.reloadUserConfig,true);
  assert.deepEqual(request.edits,RIN_RECOMMENDED_CODEX_EDITS.map(edit=>({...edit})));
  assert.deepEqual(request.edits.map(edit=>edit.keyPath),[
    'features.context_management.experimental_mode','features.memories','tool_output_token_limit','model','model_reasoning_effort','sandbox_mode','approval_policy',
    'desktop.preventSleepWhileRunning','desktop.keepRemoteControlAwakeWhilePluggedIn',
    'desktop.git-branch-prefix','desktop.git-pull-request-merge-method','desktop.worktree-upstream-refresh-mode',
    'apps.connector_20205bf7d4e99a89d7154bb849718324.enabled',
    'apps.connector_openai_hotline.enabled','apps.connector_openai_safety_settings.enabled',
  ]);
  assert.ok(request.edits.every(edit=>edit.mergeStrategy==='upsert'));
  assert.equal(request.edits.find(edit=>edit.keyPath==='approval_policy').value,'never');
  assert.equal(request.edits.find(edit=>edit.keyPath==='tool_output_token_limit').value,4000);
  assert.equal(request.edits.some(edit=>edit.keyPath==='model_auto_compact_token_limit'),false);
  assert.equal(request.edits.find(edit=>edit.keyPath==='model').value,'gpt-6-astra');
  assert.equal(request.edits.find(edit=>edit.keyPath==='model_reasoning_effort').value,'medium');
  assert.ok(!request.edits.some(edit=>/service_tier|chronicle/i.test(edit.keyPath)));
});

test('update migration removes only the obsolete compaction key',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-migration-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'model_auto_compact_token_limit = 120000\n');
  let request;
  await removeObsoleteCodexSettings({codexHome,writeConfig:async value=>{request=value;return{ok:true};}});
  assert.deepEqual(request,{edits:RIN_OBSOLETE_CODEX_EDITS.map(edit=>({...edit})),reloadUserConfig:true});
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
});

test('update migration leaves an absent config and an unrelated config untouched',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-noop-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  let writes=0,resolves=0;
  const options={codexHome,writeConfig:async()=>{writes++;},resolveCommand:async()=>{resolves++;}};
  assert.deepEqual(await removeObsoleteCodexSettings(options),{status:'unchanged'});
  await writeFile(join(codexHome,'config.toml'),'model = "gpt-6-astra"\n');
  assert.deepEqual(await removeObsoleteCodexSettings(options),{status:'unchanged'});
  assert.equal(writes,0);assert.equal(resolves,0);
});

test('a same-named key inside a TOML table is not treated as the managed root key',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-scoped-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'[profiles.work]\nmodel_auto_compact_token_limit = 90000\n');
  let writes=0;
  assert.deepEqual(await removeObsoleteCodexSettings({codexHome,writeConfig:async()=>{writes++;}}),{status:'unchanged'});
  assert.equal(writes,0);
});

test('declining recommendations remains a pure choice with an explicit preservation message',async()=>{
  const {collectChoices}=await import('../dist/install/setup.js'); const output=[];
  const answers=[[],false,'skip',true];
  const ui={intro(){},note(){},outro(){},cancel(){},isCancel(){return false},multiselect:async()=>answers.shift(),confirm:async()=>answers.shift(),select:async()=>answers.shift(),text:async()=>answers.shift(),log:{info:line=>output.push(line),error(){}}};
  const choices=await collectChoices({ui});
  assert.equal(choices.recommendations,false);assert.match(output.join('\n'),/Existing Codex settings will be preserved/);
});

for(const value of [true,false]) {
  test(`context management migration preserves boolean ${value}`,async t=>{
    const codexHome=await mkdtemp(join(tmpdir(),'rin-context-migration-'));
    t.after(()=>rm(codexHome,{recursive:true,force:true}));
    await writeFile(join(codexHome,'config.toml'),`[features]\ncontext_management = ${value}\n`);
    const filePath=await realpath(join(codexHome,'config.toml'));
    let request;
    const result=await migrateContextManagementConfig({codexHome,
      readConfig:async params=>{
        assert.deepEqual(params,{includeLayers:true});
        return{config:{features:{context_management:!value}},layers:[
          {name:{type:'user',file:filePath},version:'original',config:{features:{context_management:value,memories:true}}},
        ]};
      },
      writeConfig:async params=>{request=params;return{status:'ok'};},
    });
    assert.equal(result.status,'migrated');
    assert.deepEqual(request,{
      edits:[{keyPath:'features.context_management',value:{experimental_mode:value},mergeStrategy:'replace'}],
      filePath,expectedVersion:'original',reloadUserConfig:true,
    });
  });
}

test('context migration skips absent files and keys without invoking Codex',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-context-absent-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  const unexpected=async()=>{assert.fail('Codex must not be invoked');};
  const options={codexHome,resolveCommand:unexpected,writeConfig:unexpected,readConfig:unexpected};
  assert.deepEqual(await migrateContextManagementConfig(options),{status:'unchanged'});
  await writeFile(join(codexHome,'config.toml'),'[features]\nmemories = true\n');
  assert.deepEqual(await migrateContextManagementConfig(options),{status:'unchanged'});
});

test('context migration leaves tables, profiles and non-user layers untouched',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-context-scopes-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'# context_management\n');
  const filePath=await realpath(join(codexHome,'config.toml'));
  for(const config of [
    {features:{context_management:{experimental_mode:false,extra:true}}},
    {profiles:{work:{features:{context_management:true}}}},
    {},
  ]) {
    const result=await migrateContextManagementConfig({codexHome,
      readConfig:async()=>({layers:[
        {name:{type:'system',file:'/etc/codex/config.toml'},config:{features:{context_management:true}}},
        {name:{type:'user',file:filePath,profile:'work'},config:{features:{context_management:true}}},
        {name:{type:'user',file:filePath},version:'v',config},
      ]}),
      writeConfig:async()=>{assert.fail('must not write');},
    });
    assert.deepEqual(result,{status:'unchanged'});
  }
});

test('context migration refuses missing user layer and propagates concurrent write failures',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-context-invalid-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'[features]\ncontext_management = true\n');
  const filePath=await realpath(join(codexHome,'config.toml'));
  await assert.rejects(migrateContextManagementConfig({codexHome,
    readConfig:async()=>({config:{features:{context_management:true}},layers:[]}),
    writeConfig:async()=>{assert.fail('must not write');},
  }),/base user configuration layer/);
  await assert.rejects(migrateContextManagementConfig({codexHome,
    readConfig:async()=>({layers:[{name:{type:'user',file:filePath},version:'stale',config:{features:{context_management:true}}}]}),
    writeConfig:async params=>{assert.equal(params.expectedVersion,'stale');throw new Error('version conflict');},
  }),/version conflict/);
});
