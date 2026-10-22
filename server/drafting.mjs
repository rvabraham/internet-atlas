import { readFile } from 'node:fs/promises';

export async function draftingInstructions(path = process.env.ATLAS_UNSLOP_SKILL || new URL('./prompts/unslop.md', import.meta.url)) {
  const skill = await readFile(path, 'utf8');
  return `OUTREACH DRAFTING
Apply the following $unslop skill to every generated DM and email. Read for meaning, draft, then internally revise before saving. Return the edited draft through atlas_save_draft, without explaining the editing process.

${skill}

Internet Atlas preferences: DM bodies should usually be 30-50 words, with a hard maximum of 60. Email bodies should usually be 40-70 words, with a hard maximum of 90. Use two or three short sentences and at most one question. Keep email subjects short and specific, at most 60 characters. No em dashes. Use one concrete detail from the person's own request and one useful question about their workflow or current workaround. Do not add generic greetings, praise, "hope you're well", a sales pitch, invented familiarity, an offer the user has not made, unsupported claims, or a meeting request by default. A brief name greeting is optional. Cite one original source URL once. Keep uncertainty that matters; do not turn a public request into purchase intent. Check the public profile and source before drafting, and keep unavailable details blank. After saving, respond with one short confirmation and its source link. The draft is already visible in the editor, so do not repeat it in chat.`;
}

/** Generated outreach is constrained; user-authored drafts remain freely editable. */
export function validateGeneratedDraft(input) {
  const body = String(input.body || '').trim(), subject = String(input.subject || '').trim();
  const words = body ? body.split(/\s+/).length : 0;
  const maximum = input.channel === 'email' ? 90 : 60;
  if (!body) throw new Error('Write a concise draft grounded in this requester\'s source.');
  if (words > maximum) throw new Error(`Revise with $unslop: keep this ${input.channel === 'email' ? 'email' : 'DM'} under ${maximum} words, preserving the concrete detail and useful question. Do not truncate it.`);
  if (/[—]/.test(body + subject)) throw new Error('Revise the draft without em dashes.');
  if ((body.replace(/https?:\/\/\S+/g, '').match(/\?/g) || []).length > 1) throw new Error('Ask one clear question. Revise the draft with $unslop before saving.');
  if (input.channel === 'email' && subject.length > 60) throw new Error('Keep the email subject under 60 characters.');
  return { ...input, body, subject };
}
