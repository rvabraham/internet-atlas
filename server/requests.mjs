// Only explicit asks contribute to request tiers. Votes and generic discussion do not.
const ASK = /\b(?:i\s+(?:really\s+)?(?:wish|need|want)|we\s+(?:really\s+)?(?:need|want)|i(?:'|’)m looking for|i am looking for|looking for (?:a|an|some|the best)|i(?:'|’)d (?:love|like|pay)|i would (?:love|like|pay)|would (?:love|like) (?:to|a|an|the)|wish (?:there|it|we)|is there (?:a|an|any)|does (?:anyone|anybody) know|can (?:anyone|somebody) recommend|any recommendations for|please (?:add|support|implement|allow|provide)|would be (?:great|nice|useful|helpful) (?:if|to))\b/i;
const PROMOTION = /\b(?:i (?:built|created|launched)|we (?:built|created|launched)|i(?:'|’)?m (?:the |a |solo )?founder|i am (?:the |a |solo )?founder|our (?:product|platform)|try my (?:app|tool)|looking for (?:beta (?:users|testers)|testers|customers|early adopters)|show hn:)\b/i;
const ADVICE = /looking for (?:advice|feedback|a co-?founder|investors|funding|a job|work|clients|customers|testers|beta users)/i;
export const SOFTWARE = /\b(?:software|tool|app|api|saas|workflow|automation|automate|agent|llm|chatgpt|claude|pdf|full.?text|bookmarks?|read.?later|caldav|outlook|plugin|self.host|database|dashboard|integration|webhook|billing|authentication|notion|obsidian|n8n|docker|code|developer|deploy|crm|email|calendar|spreadsheet|test|testing|flaky|ci|permission|permissions|scheduling|context|retry|retries|sync|synchronization|offline|deduplication|idempotency)\b/i;

const unavailableStatuses = new Set(['deleted', 'closed', 'resolved', 'removed', 'private', 'withdrawn', 'opted-out', 'optedout', 'redacted', 'unavailable']);
const unavailableFlags = ['deleted', 'removed', 'opted_out', 'optedOut', 'optOut', 'redacted', 'withdrawn', 'private', 'unavailable', 'is_deleted', 'is_removed', 'is_opted_out', 'is_redacted', 'is_withdrawn', 'is_private', 'is_unavailable'];
const trueFlag = value => value === true || value === 1 || typeof value === 'string' && /^(?:true|1|yes)$/i.test(value.trim());
export const attributableSource = record => {
  const author = String(record.author || '').trim(), status = String(record.status || '').toLowerCase().replace(/[_ ]/g, '-');
  return !trueFlag(record.synthetic) && !trueFlag(record.is_synthetic) && !unavailableStatuses.has(status) && !unavailableFlags.some(key => trueFlag(record[key]))
    && !['', 'unknown', 'anonymous', '[deleted]', '[removed]', 'deleted'].includes(author.toLowerCase())
    && !/\[deleted\]|^AutoModerator$|\[bot\]/i.test(author)
    && !(record.source === 'github' && author.toLowerCase() === 'ghost');
};

export function detectRequest(record) {
  if (!attributableSource(record)) return null;
  const title = String(record.title || '');
  let text = String(record.text || '');
  // Issue checklists describe the template, not the requested behavior.
  const section = /#{2,3}\s+(?:Feature Description|Description|Problem(?: statement)?|Motivation|Use case)\s*[:\n]?\s*/i.exec(text);
  if (record.source === 'github' && record.recordType !== 'comment' && section) text = text.slice(section.index + section[0].length);
  const content = `${title}\n${text}`;
  if (record.recordType !== 'comment' && /^show hn\s*:/i.test(title)) return null;
  if (record.recordType === 'comment' && /^\s*(?:\+1|same here|me too|following|any updates|bump)[\s!.?]*$/i.test(text)) return { type: 'endorsement', quote: text.trim(), method: 'explicit-comment' };
  if (/who (?:is hiring|wants to be hired)|seeking (?:work|freelancer)|freelancer.*seeking|hiring thread|\b(?:resume|résumé|job search)\b/i.test(title)) return null;
  if (/\bi would like to thank\b|\bi(?:'|’)d like to thank\b/i.test(text) && !/please (?:add|support|implement)|i (?:need|wish)/i.test(text)) return null;
  if (PROMOTION.test(record.recordType === 'comment' ? text : content) || /we(?:'|’)re solving|our (?:tool|framework)|try (?:agenium|pathcourse)/i.test(text) || ADVICE.test(title)) return null;
  const featureTitle = record.recordType !== 'comment' && (/\b(?:feature request|request for|enhancement)\b|\[(?:feature|feat)\]|^\s*feat(?:ure)?\s*:/i.test(title) || (record.labels || []).some(label => /^(?:enhancement|feature|feature.request|type: ?feature)$/i.test(label)));
  const match = ASK.exec(text) || ASK.exec(title);
  const recommendation = record.recordType !== 'comment' && (record.source === 'stackexchange' || (/\b(?:recommend|alternative to|looking for|(?:software|tool|app) (?:for|to))\b/i.test(title) && /\?|\blooking for\b/i.test(title) && SOFTWARE.test(content)));
  if (!featureTitle && !match && !recommendation) return null;
  if (!featureTitle && !SOFTWARE.test(content)) return null;
  const start = match && text.includes(match[0]) ? match.index : 0;
  const excerpt = text.slice(start, start + 650).trim();
  const quote = match ? excerpt.split(/(?<=[.!?])\s+(?=[A-Z])/).slice(0, 2).join(' ').slice(0, 500) : excerpt;
  if (!quote || quote.length < 20) return null;
  // A software article's title cannot turn an unrelated personal wish into product demand.
  if (!featureTitle && !recommendation && !SOFTWARE.test(quote)) return null;
  return { type: featureTitle ? 'feature_request' : recommendation || /looking for|recommend|is there|does anyone/i.test(match?.[0] || '') ? 'product_search' : 'feature_request', quote, method: featureTitle ? 'feature-title-or-label' : recommendation ? 'recommendation-question' : 'explicit-ask' };
}

export function priorityTier(count) {
  if (count >= 50) return { id: 'strong', label: 'Strong', rank: 3, nextAt: null };
  if (count >= 20) return { id: 'growing', label: 'Growing', rank: 2, nextAt: 50 };
  if (count >= 10) return { id: 'recurring', label: 'Recurring', rank: 1, nextAt: 20 };
  return { id: 'early', label: 'Early', rank: 0, nextAt: 10 };
}

export function requestFor(record) {
  if (!attributableSource(record)) return null;
  if (record.reviewDecision?.status === 'excluded') return null;
  if (!record.problemAnalysis) return Object.hasOwn(record, 'problemAnalysis') ? null : detectRequest(record);
  const understood = record.problemAnalysis;
  if (understood.classification !== 'request' || understood.confidence < .65 || understood.requesterRole === 'vendor' || ['deleted', 'closed', 'resolved', 'removed'].includes(record.status)) return null;
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  if (String(understood.evidenceQuote).includes('[Quoted passage omitted]')) return null;
  if (!normalize(`${record.title}\n${record.text}`).includes(normalize(understood.evidenceQuote))) return null;
  return { type: 'product_request', quote: understood.evidenceQuote, method: 'problem-understanding', problem: understood.problem, workflow: understood.workflow, desiredOutcome: understood.desiredOutcome };
}
