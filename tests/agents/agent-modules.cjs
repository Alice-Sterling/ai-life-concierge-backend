const assert = require('assert');

const historyManager = require('../../src/agents/historyManager');
const toolOrchestrator = require('../../src/agents/toolOrchestrator');
const promptBuilder = require('../../src/agents/promptBuilder');

let passed = 0;
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected);
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('\nHANDOFF / AI MODE DECISIONS');
check('human mode bypasses Alice', toolOrchestrator.shouldBypassAlice({ conversation_mode: 'human' }), true);
check('ai mode lets Alice respond', toolOrchestrator.shouldBypassAlice({ conversation_mode: 'ai' }), false);
check('missing mode defaults to Alice', toolOrchestrator.shouldBypassAlice({}), false);

console.log('\nTIMEZONE / RELATIVE DATE RESOLUTION');
const now = new Date('2026-11-09T12:00:00Z');
check(
  'tomorrow 7pm anchored to user timezone label',
  toolOrchestrator.resolveRelativeDateTime('tomorrow 7pm', {
    now,
    activeTimezone: 'Europe/London',
  }).startsWith('2026-11-10 19:00 Europe/London'),
  true
);
check(
  'next Tuesday 08:30 resolved from current UTC anchor',
  toolOrchestrator.resolveRelativeDateTime('next Tuesday 08:30', {
    now,
    activeTimezone: 'Europe/London',
  }).startsWith('2026-11-10 08:30 Europe/London'),
  true
);
check('empty relative date returns null', toolOrchestrator.resolveRelativeDateTime('', { now }), null);
const anchor = promptBuilder.buildTimeAnchor({ activeTimezone: 'Asia/Dubai', now });
check('time anchor includes UTC ISO', anchor.currentUtcTime, '2026-11-09T12:00:00.000Z');
check('time anchor keeps user timezone', anchor.userTimezone, 'Asia/Dubai');

console.log('\nTOOL SCHEMA VALIDATION');
const tool = {
  name: 'example_tool',
  input_schema: {
    required: ['date', 'count', 'kind'],
    properties: {
      date: { type: 'string' },
      count: { type: 'integer' },
      kind: { type: 'string', enum: ['a', 'b'] },
    },
  },
};
check('valid tool input passes', toolOrchestrator.validateToolInput(tool, { date: '2026-11-10', count: 2, kind: 'a' }).ok, true);
check('missing and enum failures are reported', toolOrchestrator.validateToolInput(tool, { count: 1, kind: 'c' }).ok, false);

console.log('\nHISTORY SLIDING WINDOW');
const rowsDesc = [];
for (let i = 12; i >= 1; i -= 1) {
  rowsDesc.push({
    message_body: `Message ${i}`,
    ai_response: `Reply ${i}`,
    metadata: {},
    timestamp: new Date(`2026-11-${String(i).padStart(2, '0')}T10:00:00Z`),
  });
}
rowsDesc.splice(3, 0, {
  message_body: 'Handshake complete. I have successfully connected my calendar.',
  ai_response: 'Handshake verified.',
  metadata: { trigger: 'handshake_verification' },
  timestamp: new Date('2026-11-13T10:00:00Z'),
});
rowsDesc.splice(6, 0, {
  message_body: 'Human queued text',
  ai_response: null,
  metadata: { queued_for_human: true },
  timestamp: new Date('2026-11-14T10:00:00Z'),
});

const history = historyManager.buildHistoryContext(rowsDesc, { windowMessages: 6, summaryMessages: 4 });
check('recent history is capped', history.messages.length, 6);
check('older summary is present', history.summary.length > 0, true);
check('noise rows are filtered from recent history', history.messages.some((m) => m.content.includes('Handshake complete')), false);
check('history entries are timestamped', /^\[2026-11-/.test(history.messages[0].content), true);

console.log(`\n${passed} passed, 0 failed`);
