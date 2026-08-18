#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs');

const builder = require('./build_deck_pptxgenjs');
const { getPreset } = require('../templates/pptxgenjs/presets');
const slideRenderers = require('../templates/pptxgenjs/slides');
const { contractsForGrammar } = require('../templates/pptxgenjs/role_layout_contracts');

const ROOT = path.resolve(__dirname, '..');
const GRAMMARS = [
  ['consulting-answer-pyramid', 'arctic-minimal', 'Answer Pyramid'],
  ['scientific-evidence-plate', 'lab-report', 'Evidence Plate'],
  ['clinical-care-pathway', 'executive-clinical', 'Care Pathway'],
  ['editorial-spread', 'editorial-minimal', 'Editorial Spread'],
  ['investor-thesis-stage', 'sunset-investor', 'Thesis Stage'],
  ['operations-grid', 'lavender-ops', 'Operating Grid'],
  ['policy-public-docket', 'warm-terracotta', 'Public Docket'],
  ['technical-telemetry-canvas', 'midnight-neon', 'Telemetry Canvas'],
];

function parseArgs(argv) {
  const args = { output: path.join(ROOT, 'examples', 'v0.9_full_deck_taste_grammar_gallery.pptx') };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--output' && argv[index + 1]) {
      args.output = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function roleSlides(grammarLabel) {
  const footer = `Urban heat resilience pilot | ${grammarLabel}`;
  return [
    {
      type: 'title', role: 'title', title: 'Cooling the Last 5 Degrees',
      subtitle: 'A neighborhood heat-resilience pilot designed for measurable relief, accountable delivery, and a 90-day decision.',
      footer,
    },
    {
      type: 'section', role: 'section', title: 'From exposure to action',
      subtitle: 'Locate the hottest blocks, test three interventions, then scale only what improves lived conditions.',
      footer,
    },
    {
      type: 'content', role: 'evidence', treatment_key: 'dashboard', variant: 'stats',
      title: 'Heat exposure is concentrated enough to make a targeted pilot testable',
      subtitle: 'Three evidence anchors before intervention',
      facts: [
        { value: '5.2°C', label: 'Peak heat gap', detail: 'versus city median' },
        { value: '14', label: 'Priority blocks', detail: 'high exposure + vulnerability' },
        { value: '38%', label: 'Low canopy', detail: 'below target coverage' },
      ],
      summary_callout: 'A small geography carries a disproportionate share of the risk.',
      footer,
    },
    {
      type: 'content', role: 'comparison', treatment_key: 'comparison', variant: 'comparison-2col',
      title: 'Permanent shade creates durable value; rapid cooling buys learning speed',
      subtitle: 'Two complementary intervention postures',
      left: {
        title: 'Build durable shade',
        bullets: ['Tree and canopy corridors', 'Higher setup cost', 'Long-lived neighborhood benefit'],
      },
      right: {
        title: 'Deploy rapid cooling',
        bullets: ['Cool roofs and misting stops', 'Fast deployment', 'Shorter asset life'],
      },
      verdict: 'Pair one durable corridor with two rapid-cooling test blocks.',
      footer,
    },
    {
      type: 'content', role: 'chart', treatment_key: 'chart', variant: 'chart',
      title: 'The combined intervention is expected to close most of the heat gap',
      subtitle: 'Modeled peak surface-temperature reduction',
      chart: {
        type: 'bar', title: 'Peak surface-temperature reduction',
        labels: ['Shade', 'Cool roof', 'Combined', 'Target'], values: [1.8, 2.4, 4.1, 4.5],
        facts: [
          { value: '4.1°C', label: 'Combined', detail: 'modeled reduction' },
          { value: '91%', label: 'Of target', detail: 'before field correction' },
        ],
        notes: 'Synthetic planning model for release demonstration; editable native chart.',
      },
      caption: 'Illustrative model values; not a public performance claim.',
      footer,
    },
    {
      type: 'content', role: 'table', treatment_key: 'table', variant: 'table',
      title: 'Each workstream has an owner, proof signal, and decision date',
      subtitle: 'Editable 90-day delivery ledger',
      headers: ['Workstream', 'Owner', 'Proof signal', 'Decision'],
      rows: [
        ['Baseline sensors', 'Climate lab', '14 blocks live', 'Day 14'],
        ['Shade corridor', 'Public works', '2°C reduction', 'Day 60'],
        ['Cool-roof cohort', 'Housing team', '3°C reduction', 'Day 60'],
        ['Resident pulse', 'Community team', 'Comfort improves', 'Day 75'],
      ],
      interpretation: 'Scale only interventions that improve both measured heat and resident comfort.',
      caption: 'Synthetic owners and thresholds for an editable demonstration.',
      footer,
    },
    {
      type: 'content', role: 'decision', treatment_key: 'decision', variant: 'matrix',
      title: 'Authorize the pilot with four explicit conditions for scale',
      subtitle: 'Decision conditions and accountability',
      quadrants: [
        { title: 'Proceed', body: 'Fund fourteen-block baseline and three intervention cohorts.' },
        { title: 'Protect', body: 'Prioritize vulnerable residents and public-space access.' },
        { title: 'Measure', body: 'Track temperature, comfort, uptime, and maintenance burden.' },
        { title: 'Stop', body: 'Do not scale an intervention that misses both proof thresholds.' },
      ],
      summary_callout: 'Decision: release pilot funds now; return at day 90 with scale evidence.',
      footer,
    },
    {
      type: 'content', role: 'references', treatment_key: 'references', variant: 'table',
      table_style: 'references', title: 'Methods and sources',
      subtitle: 'Illustrative evidence register for the editable gallery',
      headers: ['ID', 'Source', 'Use'],
      rows: [
        ['S1', 'Synthetic sensor baseline', 'Heat-gap framing'],
        ['S2', 'Synthetic canopy inventory', 'Target blocks'],
        ['S3', 'Synthetic intervention model', 'Scenario comparison'],
        ['S4', 'Synthetic resident pulse', 'Comfort threshold'],
      ],
      caption: 'All values are synthetic and included only to demonstrate source-aware slide structure.',
      footer,
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  const pptx = new PptxGenJS();
  pptx.defineLayout({
    name: 'PPTX_SKILL_16x9',
    width: slideRenderers.SLIDE_W,
    height: slideRenderers.SLIDE_H,
  });
  pptx.layout = 'PPTX_SKILL_16x9';
  pptx.title = 'v0.9 Full-Deck Taste Grammar Gallery';
  pptx.subject = 'One urban heat topic rendered through eight editable role-layout grammars.';

  const totalSlides = GRAMMARS.length * 8;
  let slideIndex = 0;
  for (const [grammarId, presetName, grammarLabel] of GRAMMARS) {
    const contract = contractsForGrammar(grammarId, presetName);
    const deckData = {
      title: 'Cooling the Last 5 Degrees',
      metadata: { renderer_role_contracts_v2: contract },
      deck_style: { footer_page_numbers: true },
    };
    const preset = builder.applyDeckStyle(getPreset(presetName), deckData, presetName);
    for (const raw of roleSlides(grammarLabel)) {
      slideIndex += 1;
      const slideData = builder.normalizeSlide(raw, ROOT);
      slideData.__slideIndex = slideIndex;
      slideData.__slideCount = totalSlides;
      const slide = pptx.addSlide();
      builder.renderSlide(pptx, slide, slideData, preset);
    }
  }

  const output = path.resolve(args.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await pptx.writeFile({ fileName: output });
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
