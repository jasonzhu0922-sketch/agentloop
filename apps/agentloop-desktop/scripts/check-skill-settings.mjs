import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { SKILL_DECLARATION_EDITOR_SCHEMA } from '@zhujun/agentloop';
import test from 'node:test';
const base=new URL('../web/', import.meta.url).pathname;
const output=process.env.SKILL_UI_OUTPUT ?? '/private/tmp/agentloop-skill-ui';
test('Skill form and installation flow render and work in a real browser at desktop and mobile widths', async () => {
  await mkdir(output,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main class="desktop-settings-content agent-settings-content" style="width:min(980px,calc(100% - 32px));max-height:none;overflow:visible;margin:32px auto;padding:24px"><section id="card" class="capability-card skill-metadata-card"></section></main></body></html>');
    await page.addStyleTag({content:await readFile(base+'multi-runtime.css','utf8')});
    await page.addStyleTag({content:await readFile(base+'styles.css','utf8')});
    await page.addScriptTag({content:(await readFile(base+'skill-settings.js','utf8')).replace(/export /g,'')+'\nwindow.createSkillMetadataForm=createSkillMetadataForm;window.renderSkillRequirements=renderSkillRequirements;window.renderSkillSetup=renderSkillSetup;'});
    const meta={ name:'data-analysis',editable:true,revision:3,source:'detected',fields:{},editorSchema:SKILL_DECLARATION_EDITOR_SCHEMA,semanticTagOptions:['business-metrics','data-query','nl2sql','中文标签'],
      declaration:{schema:'agentloop.skillDeclaration/v1',identity:{name:'data-analysis',description:'基于业务数据进行指标查询、趋势分析与报告生成。'},activation:{semanticTags:['business-metrics','data-query'],intentExamples:['分析最近六个月的销售趋势','比较各地区的销售额和同比变化']},workflow:{roles:['primary_builder','source_provider'],artifactKinds:['spreadsheet','image'],sourceKinds:['database','dataset'],qaKinds:['content'],requiredSkills:['missing-provider']},requirements:{python:{version:'>=3.10',packages:['pandas>=2','matplotlib>=3.8'],files:[]},commands:['python3'],environment:['DATA_API_URL'],mcpServers:[]},execution:{manifest:'agentloop.executors.json'},compatibility:{executionProfiles:['local_script'],producesEvidenceKinds:['source_summary','record_counts']}}};
    await page.evaluate(meta=>{window.form=createSkillMetadataForm(meta,[{skillName:'pdf',validationStatus:'valid'}]);const card=document.querySelector('#card');card.innerHTML='<div class="skill-metadata-heading"><strong>数据分析</strong><span class="skill-metadata-badge">维护元数据</span></div><p>已沿用包内声明或自动识别结果，无需逐项填写。</p>';card.append(window.form.element);const footer=document.createElement('div');footer.className='skill-metadata-footer';footer.innerHTML='<p>保存后需重启使用此 Skill 的 Runtime。</p><div class="capability-actions skill-metadata-actions"><button>取消编辑</button><button class="primary">保存声明</button></div>';card.append(footer);},meta);
    assert.equal(await page.locator('[data-field]').count(),18);
    assert.equal(await page.locator('textarea:visible,input:visible').count(),1);
    assert.equal(await page.locator('details[open]').count(),0);
    const original=await page.evaluate(()=>window.form.read());
    assert.equal(original.valid,true);
    assert.deepEqual(original.declaration,meta.declaration);
    for(const width of [1440,900,480]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`overflow at ${width}`);
      assert.ok(await page.locator('#card').evaluate(node=>node.getBoundingClientRect().height)<600,`default form too tall at ${width}`);
      await page.screenshot({path:`${output}/metadata-${width}.png`});
    }
    await page.setViewportSize({width:1100,height:900});
    await page.getByText('更多设置',{exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'语义标签',exact:true}).count(),0);
    const tags=page.getByRole('button',{name:'语义标签',exact:true});
    await tags.focus(); await page.keyboard.press('Enter');
    const search=page.getByRole('searchbox',{name:'搜索语义标签'});
    await search.fill('中文标签');
    assert.equal(await page.locator('.skill-tag-options input:visible').count(),0);
    assert.equal(await page.getByText('没有匹配的标签，请换个关键词。',{exact:true}).isVisible(),true);
    assert.deepEqual(await page.evaluate(()=>window.form.read().declaration.activation.semanticTags),meta.declaration.activation.semanticTags);
    await search.fill('NL2');
    assert.equal(await page.locator('.skill-tag-options input:visible').count(),1);
    await page.getByRole('checkbox',{name:'语义标签：nl2sql',exact:true}).check();
    await search.fill('');
    assert.equal(await page.getByRole('checkbox',{name:'语义标签：business-metrics',exact:true}).isChecked(),true);
    await page.getByRole('checkbox',{name:'语义标签：data-query',exact:true}).uncheck();
    assert.deepEqual(await page.evaluate(()=>window.form.read().declaration.activation.semanticTags),['business-metrics','nl2sql']);
    for(const width of [1440,900,480]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`tag picker overflow at ${width}`);
      await page.locator('[data-field="activation.semanticTags"]').screenshot({path:`${output}/tag-picker-${width}.png`});
    }
    await search.focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.skill-tag-picker').getAttribute('open'),null);
    assert.equal(await tags.evaluate(node=>node===document.activeElement),true);
    // Other field errors still reveal the advanced section and focus the input.
    await page.getByRole('checkbox',{name:'任务职责：主导任务',exact:true}).uncheck();
    await page.getByRole('checkbox',{name:'任务职责：提供来源数据',exact:true}).uncheck();
    await page.getByText('更多设置',{exact:true}).click();
    assert.equal(await page.evaluate(()=>window.form.read().valid),false);
    assert.equal(await page.locator('[data-section="advanced"]').getAttribute('open'),'');
    await page.getByRole('checkbox',{name:'任务职责：主导任务',exact:true}).check();
    await page.getByRole('checkbox',{name:'任务职责：提供来源数据',exact:true}).check();
    assert.equal(await page.evaluate(()=>window.form.read().valid),true);
    await page.screenshot({path:`${output}/metadata-advanced.png`});
    await page.setViewportSize({width:1100,height:900});
    await page.evaluate(async()=>{
      window.calls=[];window.changed=0;
      const report={packageId:'sample',scope:'device',packageHash:'a'.repeat(64),metadataRevision:3,checkedAt:Date.now(),environment:'host',status:'attention',canInstall:true,checks:[{label:'pandas>=2',status:'missing',detail:'当前执行环境未安装此软件包。',origin:'requirements.txt:1',kind:'python',installable:true}]};
      const api=async(path,data)=>{window.calls.push({path,data});if(path.endsWith('/diagnose'))return report;if(path.endsWith('/plan'))return {fingerprint:'a'.repeat(64),packages:['pandas>=2'],canInstall:true};if(path.endsWith('/install'))return {id:'job',status:'running',phase:'preparing',log:''};return {id:'job',status:'completed',phase:'finished',log:'Successfully installed pandas'};};
      await renderSkillRequirements({container:document.querySelector('#card'),pkg:{packageId:'sample',skillName:'data-analysis'},api,changed:async()=>window.changed++});
    });
    await page.getByRole('button',{name:'查看 Python 依赖安装方案'}).click();
    assert.equal(await page.getByRole('button',{name:'安装 Python 依赖',exact:true}).count(),1);
    assert.match(await page.locator('#card').innerText(),/安装到本机共享环境/);
    assert.match(await page.locator('#card').innerText(),/pandas>=2/);
    await page.screenshot({path:`${output}/installation-plan.png`,fullPage:true});
    await page.getByRole('button',{name:'安装 Python 依赖',exact:true}).click();
    await page.getByText('Python 依赖已安装并通过检查。',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.changed),1);
    assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.path.endsWith('/install')).length),1);
    await page.screenshot({path:`${output}/installation-completed.png`,fullPage:true});
    await page.evaluate(async()=>{
      window.setupCalls=[];
      const api=async(path,data)=>{
        window.setupCalls.push({path,data});
        return {scope:'device',selectedBy:[{id:'first',displayName:'本机 Runtime'},{id:'second',displayName:'分析 Runtime'}],modelsConfigured:true,requirements:{checks:[{label:'acceptance-source',kind:'mcp',status:'missing',detail:'请配置指定数据源。'},{label:'node',kind:'command',status:'satisfied',detail:'已找到命令。'}]}};
      };
      await renderSkillSetup({container:document.querySelector('#card'),pkg:{packageId:'uploaded',skillName:'record-reader',description:'通过指定的外部连接读取记录。'},api,changed:async()=>{},navigate:tab=>{window.navigated=tab;}});
    });
    assert.equal(await page.locator('textarea:visible').count(),0);
    assert.equal(await page.locator('select:visible').count(),0);
    assert.match(await page.locator('#card').innerText(),/已满足：已配置模型 · node/);
    assert.match(await page.locator('#card').innerText(),/待补配置/);
    for(const width of [1440,900,480]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`setup overflow at ${width}`);
      await page.locator('#card').screenshot({path:`${output}/setup-${width}.png`});
    }
    assert.equal(await page.getByRole('button',{name:'添加到此 Runtime',exact:true}).count(),0);
    assert.match(await page.locator('#card').innerText(),/已选择此 Skill：本机 Runtime · 分析 Runtime/);
    await page.getByRole('button',{name:'重新检查',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.setupCalls),[{path:'/api/skills/uploaded/setup',data:{}},{path:'/api/skills/uploaded/setup',data:{}}]);
    assert.ok(await page.evaluate(()=>window.calls.every(call=>!call.data||!('runtimeId' in call.data))));
    await page.getByRole('button',{name:'配置 MCP',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.navigated),'mcp');
    assert.deepEqual(errors,[]);
    console.log(output);
  }finally{await browser.close();}
});
