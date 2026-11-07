import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('purple theme supplies mascot and completion accents without changing other themes', () => {
  const theme = readFileSync(new URL('../web/multi-runtime.css', import.meta.url), 'utf8');
  const conversation = readFileSync(new URL('../web/conversation.css', import.meta.url), 'utf8');
  const purple = theme.match(/:root\[data-theme="purple"\]\{[^}]*--completion-accent:[^}]+\}/)?.[0];
  assert.ok(purple);
  for (const variable of ['--completion-accent:var(--brand)', '--mascot-border:', '--mascot-shadow:', '--mascot-background:']) {
    assert.ok(purple.includes(variable), `purple theme defines ${variable}`);
  }
  for (const selector of ['.assistant-state.completed', '.live-card.completed', '.event-feedback .live-event-indicator.completed']) {
    const rule = conversation.slice(conversation.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /var\(--completion-accent, var\(--ok\)\)/);
  }
});
