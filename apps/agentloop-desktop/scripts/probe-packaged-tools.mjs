// Copied into relocated Resources by smoke-package.mjs, never into the release.
import assert from 'node:assert/strict';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerExecutor } from '@zhujun/agentloop';
import { packagedToolEnvironment, verifyPackagedPython } from './packaged-tools.mjs';
import { readFile } from 'node:fs/promises';
const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(root, 'desktop-config.json'), 'utf8'));
const environment = await packagedToolEnvironment(root, config, { PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin' });
await verifyPackagedPython(root, config, environment);
const executor = new ComputerExecutor(process.cwd(), { commandEnvironment: environment,
  commandSandbox: { mode: 'required', readOnlyRoots: [join(root, 'node_modules'), join(root, 'runtime-python')] } });
async function command(command, args) {
  const result = await executor.runCommand({ command, args, cwd: '.', timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  assert.equal(result.executionReceipt.effectScope, 'unbounded', 'network-capable commands can affect services outside the workspace');
  return result.stdout.trim();
}
const nodePath = await command('node', ['-p', 'process.execPath']);
assert.equal(await realpath(nodePath), await realpath(join(root, 'runtime/bin', process.platform === 'win32' ? 'node.exe' : 'node')));
for (const alias of ['python', 'python3']) {
  const python = JSON.parse(await command(alias, ['-c', 'import json,sys; print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"version":sys.version.split()[0]}))']));
  assert.equal(await realpath(python.prefix), await realpath(join(root, 'runtime-python')));
  assert.equal(await realpath(dirname(python.executable)), await realpath(join(root, process.platform === 'win32' ? 'runtime-python' : 'runtime-python/bin')));
  assert.equal(python.version, config.python.version);
  // Exercise the data-query baseline through the same sandbox and PATH used
  // by Skills. Loading libpq must use the shipped binary, not a host install.
  await command(alias, ['-c', `import psycopg, psycopg_pool, sqlglot
from psycopg import pq
assert pq.__impl__ == 'binary', pq.__impl__
assert pq.version() > 0
assert sqlglot.parse_one('SELECT 1 AS value', dialect='postgres').sql(dialect='postgres') == 'SELECT 1 AS value'
`]);
}
await command('python', ['-c', `from openpyxl import Workbook,load_workbook
from reportlab.pdfgen import canvas
from pypdf import PdfReader
from pptx import Presentation
w=Workbook();w.active['A1']='Bundled Python';w.save('probe.xlsx')
assert load_workbook('probe.xlsx').active['A1'].value=='Bundled Python'
c=canvas.Canvas('probe.pdf');c.drawString(72,720,'Bundled Python');c.save()
assert 'Bundled Python' in PdfReader('probe.pdf').pages[0].extract_text()
p=Presentation();p.slides.add_slide(p.slide_layouts[0]).shapes.title.text='Bundled Python'
p.save('python-probe.pptx')
assert Presentation('python-probe.pptx').slides[0].shapes.title.text=='Bundled Python'
`]);
await command('node', ['-e', `const fs=require('node:fs');const {Document,Packer,Paragraph}=require('docx');const PptxGenJS=require('pptxgenjs');require('jszip');
(async()=>{fs.writeFileSync('probe.docx',await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('Bundled Node')]}]})));const p=new PptxGenJS();p.addSlide().addText('Bundled Node');await p.writeFile({fileName:'probe.pptx'});})().catch(e=>{console.error(e);process.exit(1)});`]);
assert.match(await command('markitdown', ['probe.pptx']), /Bundled Node/);
for (const file of ['probe.xlsx', 'probe.pdf', 'probe.docx', 'probe.pptx', 'python-probe.pptx']) assert.ok((await stat(join(process.cwd(), file))).size > 100);
console.log('Relocated command executor: bundled python/python3/node, Python imports, XLSX/PDF/DOCX/PPTX generation and markitdown conversion passed.');
