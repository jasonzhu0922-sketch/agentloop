import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createWebServer } from '../../web/server.mjs';

// Exercise the production templates and DOM reconciliation without creating a
// real Run or mutating an existing account. The Web server serves real assets.
const app = await readFile(new URL('../../web/client/app.js', import.meta.url), 'utf8');
const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = `
import { renderProcess } from './packages/agentloop-conversation-ui/process.js';
import { renderHumanLoop as renderInlineHumanLoop, bindHumanLoop } from './packages/agentloop-conversation-ui/human-loop.js';
import { liveProgressForEvent } from './apps/agentloop-multi-runtime/web/client/projections/assistant-event-projection.js';
import { assistantMessagePresentation, completedArtifactSummary, terminalAwarePlanStepStatus } from './apps/agentloop-multi-runtime/web/client/presentation/assistant-message-presentation.js';
import { isExecutionLogArtifact, isFinalDeliveryArtifact, artifactVerificationLabel } from './apps/agentloop-multi-runtime/web/client/presentation/artifact-display.js';
import { isNearBottom, nextScrollTop } from './apps/agentloop-multi-runtime/web/client/ui/scroll-follow.js';
import { hasSelectedTextWithin } from './apps/agentloop-multi-runtime/web/client/ui/message-selection.js';
import { renderMarkdown } from './packages/agentloop-artifact-preview/src/index.ts';
const $ = id => document.getElementById(id);
let renderedConversationId;
const availableModels = [];
const conversation = {id:'qa',messages:[]};
const activeConversation = () => conversation;
const executionProvenanceParts = () => [{kind:'runtime', label:'QA Runtime'}];
const hydrateCommandEvidence = async () => {};
const requestLiveAssistantUpdate = () => render();
const previewArtifact = () => { globalThis.previewCalls++; };
const downloadArtifact = () => {};
const startFromCheckpoint = () => {};
const renderResolvedHumanLoops = () => '';
globalThis.previewCalls = 0;
let requests=0, release;
const submitHumanLoop = async () => { requests++; await new Promise(resolve => release=resolve); throw new Error('QA offline'); };
${part('function captureAssistantUi(', '\nasync function deleteConversation')}
${part('function selectedAssistantMessage(', '\nfunction conversationTurnLabel')}
${part('function renderMessage(', '\nasync function copyConversationMessage')}
${part('function renderHumanLoop(message)', '\nfunction renderResolvedHumanLoops')}
${part('function renderRecovery(', '\nasync function startFromCheckpoint')}
${part('function projectPlanStatuses(', '\nfunction renderPendingAttachments')}
${part('function renderAttachmentChip(', '\nfunction renderArtifacts')}
${part('function planStepLabel(', '\nasync function call(')}
function render() { syncConversationMessages(conversation,conversation.messages); renderedConversationId=conversation.id; }
globalThis.qa={ conversation, render, requests:()=>requests, fail:()=>release?.() };
`;
const outputDir = resolve(process.argv[2] || '/tmp/agentloop-conversation-flow-qa');
await mkdir(outputDir, { recursive: true });
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'js' }, bundle: true, format: 'iife', platform: 'browser', write: false });
const server = createWebServer();
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of ['process.js', 'human-loop.js', 'conversation.css']) {
    const response = await fetch(`${base}/packages/agentloop-conversation-ui/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), await readFile(new URL(`../../../../packages/agentloop-conversation-ui/${name}`, import.meta.url), 'utf8'));
  }
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__conversation-qa', route => route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><html><head><link rel="stylesheet" href="/styles/styles.css"><link rel="stylesheet" href="/styles/runtime-overrides.css"><link rel="stylesheet" href="/artifact-markdown.css"><link rel="stylesheet" href="/packages/agentloop-conversation-ui/conversation.css"></head><body><main id="conversation-scroll"><div id="messages" class="messages"></div></main></body></html>` }));
  await page.goto(`${base}/__conversation-qa`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const e=(seq,type,data={})=>({seq,type,data,createdAt:seq});
    qa.conversation.messages=[{id:'user',role:'user',text:'对齐 Desktop 的对话流',createdAt:1},
      {id:'history',role:'assistant',status:'completed',text:'这是已经完成的历史回答。',createdAt:1,completedAt:2000,events:[],plan:[]},
      {id:'live',role:'assistant',status:'running',text:'检查中',createdAt:2001,events:[e(1,'assistant.committed',{content:'先检查资料'}),e(2,'tool.planned',{toolCallId:'call',toolName:'computer_run_command',arguments:{command:'python3',args:['report.py']}}),e(3,'tool.completed',{toolCallId:'call',result:JSON.stringify({exitCode:0,stdout:'<script>escaped</script>\n完整输出'})})],plan:[]}];
    qa.render(); globalThis.historyNode=document.querySelector('[data-assistant-message="history"]');
  });
  await page.locator('[data-tool-group]').click();
  await page.locator('[data-tool-call] summary').click();
  await page.evaluate(() => { qa.conversation.messages[2].events.push({seq:4,type:'assistant.committed',data:{content:'继续检查'}}); qa.render(); });
  assert.equal(await page.locator('[data-tool-call]').evaluate(node=>node.open), true);
  assert.equal(await page.evaluate(() => historyNode===document.querySelector('[data-assistant-message="history"]')), true);
  assert.equal(await page.locator('[data-tool-call]').count(), 1);
  assert.equal(await page.locator('[data-assistant-message="live"] .live-output-text').count(), 0);
  await page.locator('[data-assistant-message="history"] .live-output-text').click();
  assert.equal(await page.evaluate(()=>previewCalls), 0);
  // Selection survives a structural render and resumes on the next reconcile.
  await page.evaluate(()=>{ const range=document.createRange(); range.selectNodeContents(document.querySelector('[data-assistant-message="live"] .process-text')); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); globalThis.selectedNode=document.querySelector('[data-assistant-message="live"]'); qa.conversation.messages[2].events.push({seq:5,type:'assistant.committed',data:{content:'更新后的过程'}}); qa.render(); });
  assert.equal(await page.evaluate(()=>selectedNode===document.querySelector('[data-assistant-message="live"]')),true);
  await page.evaluate(()=>{window.getSelection().removeAllRanges();qa.render();});
  await page.evaluate(()=>{qa.conversation.messages[2].humanLoop={id:'question',revision:1,status:'open',title:'补充输入',prompt:'请填写说明',rationale:'继续前需要填写',responseSchema:{type:'form',fields:[{id:'note',label:'说明',required:true,valueType:'textarea'}]}};qa.render();});
  const field=page.locator('form[data-human-loop] textarea');
  await field.fill('保留这段未提交的草稿');
  await page.evaluate(()=>{globalThis.formNode=document.querySelector('form[data-human-loop]');qa.conversation.messages[2].events.push({seq:6,type:'model.request.started',data:{phase:'execution'}});qa.render();});
  assert.equal(await field.inputValue(),'保留这段未提交的草稿');
  assert.equal(await page.evaluate(()=>formNode===document.querySelector('form[data-human-loop]')),true);
  await page.locator('form button[type="submit"]').click();
  await page.evaluate(()=>qa.render());
  assert.equal(await page.locator('form fieldset').evaluate(node=>node.disabled),true);
  assert.equal(await page.evaluate(()=>qa.requests()),1);
  await page.evaluate(()=>qa.fail());
  await page.waitForFunction(()=>document.querySelector('.human-loop-feedback').textContent.includes('QA offline'));
  assert.equal(await field.inputValue(),'保留这段未提交的草稿');
  assert.equal(await page.locator('form fieldset').evaluate(node=>node.disabled),false);
  await page.screenshot({path:resolve(outputDir,'live-desktop-flow.png'),fullPage:true});
  await page.evaluate(()=>{qa.conversation.messages[2].humanLoop.revision=2;qa.render();});
  assert.equal(await field.inputValue(),'');
  await page.evaluate(()=>{const turn=qa.conversation.messages[2];turn.status='completed';turn.processOpen=false;turn.humanLoop=undefined;turn.text='**最终回答**：对话流已统一。';turn.completedAt=125900;turn.artifacts=Array.from({length:8},(_,i)=>({id:'f'+i,name:'报告-'+i+'.html',bytes:1200,role:i===5?'final':'process',verification:{delivery:i===5?'committed':'uncommitted'},previewable:true}));qa.render();});
  assert.equal(await page.locator('[data-assistant-message="live"] .execution-process').isVisible(),false);
  assert.equal(await page.locator('[data-assistant-message="live"] .live-output-text strong').textContent(),'最终回答');
  assert.equal(await page.locator('[data-artifact-card]').count(),3);
  await page.locator('[data-artifacts-toggle]').click();
  assert.equal(await page.locator('[data-artifact-card]').count(),8);
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:960});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(100);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    assert.equal(overflow,false,`overflow at ${width}`);
    await page.screenshot({path:resolve(outputDir,`terminal-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  await writeFile(resolve(outputDir,'results.json'),JSON.stringify({passed:true,checks:['served shared assets','chronological process','single tool row','native details state','history DOM identity','message click boundary','selected text','HIL draft and in-flight submit preservation','terminal folding','artifact expansion','1280 and 390 width overflow'],errors},null,2));
  console.log(`Conversation browser QA passed: ${outputDir}`);
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
