import test from 'node:test';
import assert from 'node:assert/strict';
import { draftingInstructions, validateGeneratedDraft } from '../server/drafting.mjs';

test('the actual unslop skill and concise outreach preferences enter the model instructions', async () => {
  const prompt = await draftingInstructions();
  assert.match(prompt, /Preserve its claims, uncertainty, stance, and intended tone/);
  assert.match(prompt, /Prefer deleting an unnecessary sentence/);
  assert.match(prompt, /hard maximum of 60/); assert.match(prompt, /hard maximum of 90/);
  assert.match(prompt, /do not repeat it in chat/);
});
test('valid generated drafts preserve their meaning and source', () => {
  const body = 'Hi Alex, your post says searching across local PDFs is still manual. What have you tried so far? https://news.ycombinator.com/item?id=123';
  assert.deepEqual(validateGeneratedDraft({ channel: 'dm', body, subject: '' }), { channel: 'dm', body, subject: '' });
});
test('long drafts, multiple questions and em dashes are returned for revision rather than silently cut', () => {
  assert.throws(() => validateGeneratedDraft({ channel: 'dm', body: 'word '.repeat(61) }), /under 60 words/);
  assert.throws(() => validateGeneratedDraft({ channel: 'email', body: 'word '.repeat(91) }), /under 90 words/);
  assert.throws(() => validateGeneratedDraft({ channel: 'dm', body: 'What happened? What have you tried?' }), /one clear question/);
  assert.throws(() => validateGeneratedDraft({ channel: 'dm', body: 'Your request — what do you use now?' }), /em dashes/);
  assert.throws(() => validateGeneratedDraft({ channel: 'email', body: 'What do you use now?', subject: 'x'.repeat(61) }), /subject under 60/);
});
