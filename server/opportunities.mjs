import { requestRecords } from './signals.mjs';
import { attributableSource } from './requests.mjs';
import { canonicalSourceUrl } from '../shared/citations.mjs';

const YEAR = 365 * 86400000;
const normalize = value => String(value || '').replace(/\s+/gu, ' ').trim();
const accountKey = record => ['github', 'reddit', 'x'].includes(record.source) ? record.authorId.toLowerCase() : record.authorId;
const distinct = values => [...new Set(values.filter(Boolean))];
const STOP = new Set('about across actual again agent agents also another apps app available better build building can could current desired different does doing easy existing feature find first from have help into issue like make more need needs next only outcome people please problem product request requests should some software specific support system that their them there these they this through tool tools user users using want wants what when where which while with workflow would'.split(' '));
const terms = value => distinct((String(value).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(term => !STOP.has(term)));
const PAYMENT = /\b(?:i(?:'d|’d| would| will)|we(?:'d|’d| would| will))\s+(?:happily\s+)?pay\b(?!\s+(?:attention|respect|homage|tribute|mind|it forward)\b)|\b(?:i(?:'m|’m| am)|we(?:'re|’re| are))\s+(?:willing|happy|prepared)\s+to\s+pay\b(?!\s+(?:attention|respect|homage|tribute|mind|it forward)\b)|\b(?:my|our)\s+budget\s+(?:is|of)\s*(?:[$€£]\s*\d|\d[\d,.]*\s*(?:usd|eur|gbp|dollars|euros|pounds)\b)/i;
const WORKAROUND = /\b(?:workaround|work around|manually|by hand|copy[ -]?past(?:e|ing)|custom script|cobbl(?:e|ed)|spreadsheet|wrote (?:my own|a) script)\b/i;
const ALTERNATIVE_SEARCH = /\b(?:alternative(?:s)? to|replacement for|looking for (?:an? )?(?:alternative|replacement)|switch(?:ing)? (?:from|away)|replace (?:my|our|the)|instead of)\b/i;
const PRODUCT_SEARCH = /\b(?:looking for|in search of|recommend(?:ation)?|alternative(?:s)?|replacement|is there (?:an?|any)|does (?:anyone|anybody) know)\b/i;
const CONSTRAINT = /\b(?:offline|self.hosted|local.first|on.prem(?:ises)?|privacy|private|gdpr|budget|without uploading|without (?:a )?subscription|end.to.end encrypt|under\s+[$€£]\d|must|cannot|can't)\b/i;
const ALTERNATIVE_CONTEXT = /\b(?:already (?:use|using|exists|supports|solved|does)|currently (?:use|using)|i (?:use|tried|switched)|we (?:use|tried|switched)|alternative to|instead of|solved (?:it|this)|works for (?:me|us)|built.in)\b/i;
const MAINTENANCE = /\b(?:bump|upgrad(?:e|ing)|dependency update|update dependenc|deprecated|deprecation|node(?:js)?\s*\d|python\s*\d|version compatib|fix (?:a |the )?(?:typo|crash|exception)|stack trace|compilation error)\b/i;
const NARROW_FEATURE = /\b(?:add (?:a |an |the )?(?:flag|option|parameter|argument|endpoint|property|field)|expose (?:a |an |the )?(?:method|property|field|parameter)|config(?:uration)? (?:flag|option|parameter)|syntax highlighting|typo|indentation|button (?:color|colour)|rename (?:a |the )?(?:method|field))\b/i;
const BUG_CONFIG = /\b(?:bug|crash|exception|broken|regression|stack trace|config(?:uration)? (?:error|fix)|fix(?:ing)? (?:a |the )?(?:error|issue|failure))\b/i;
const REPEATED_JOB = /\b(?:manag|track|search|sync|automat|receiv|process|organiz|schedul|monitor|reconcil|notif|review|collect|audit|recover|deploy|protect|shar|stor|query|integrat|coordinat|index|control|communicat|deliver|retriev|backup|back up|triage|maintain|test|plan)\w*/i;

function repository(record) {
  if (record.source !== 'github') return null;
  if (typeof record.repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(record.repository)) return record.repository.toLowerCase();
  try { const url = new URL(record.url); return url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/(?:issues|discussions)\//.test(url.pathname) ? url.pathname.split('/').slice(1, 3).join('/').toLowerCase() : null; } catch { return null; }
}

function evidence(record, quote = record.request.quote, kind) {
  return { sourceId: record.id, accountId: accountKey(record), platform: record.source, quote, url: record.url, date: record.date, ...(kind ? { kind } : {}) };
}

function bucket(records, pattern, kind) {
  const matches = records.flatMap(record => {
    const quote = pattern.test(record.request.quote) ? record.request.quote : contextualQuotes(record, pattern)[0];
    return quote ? [{ ...evidence(record, quote, kind), requiresContextReview: true }] : [];
  });
  return { accountCount: new Set(matches.map(row => row.accountId)).size, sourceIds: matches.map(row => row.sourceId), evidence: matches.slice(0, 40) };
}

function contextualQuotes(record, pattern) {
  const text = String(record.text || '');
  // These are literal source excerpts. They are not an inferred competitor list.
  return text.split(/(?<=[.!?])\s+|\n+/u).map(part => part.trim()).filter(part => part.length >= 20 && part.length <= 900 && !part.includes('[Quoted passage omitted]') && pattern.test(part));
}

function relatedContext(signal, records, memberIds, now) {
  const meaningTerms = terms(`${signal.workflow || ''} ${signal.problem || ''} ${signal.desiredOutcome || signal.label || ''}`);
  if (meaningTerms.length < 2) return [];
  const context = [];
  for (const record of records) {
    if (context.length >= 12) break;
    if (memberIds.has(record.id) || !attributableSource(record) || !record.authorId || !Number.isFinite(Date.parse(record.date)) || Date.parse(record.date) > now) continue;
    const text = String(record.text || '').toLowerCase();
    if (!ALTERNATIVE_CONTEXT.test(text) || meaningTerms.filter(term => text.includes(term)).length < Math.min(3, meaningTerms.length)) continue;
    for (const quote of contextualQuotes(record, ALTERNATIVE_CONTEXT)) {
      const words = new Set(terms(quote));
      if (meaningTerms.filter(term => words.has(term)).length < Math.min(3, meaningTerms.length)) continue;
      context.push({ ...evidence(record, quote, 'related-alternative-discussion'), sameProblemVerified: false, contributesToDemand: false });
      break;
    }
  }
  return context;
}

function cohort(records, cutoff) {
  const byAccount = new Map();
  for (const record of records) {
    const id = accountKey(record), current = Date.parse(record.date) >= cutoff;
    let row = byAccount.get(id);
    if (!row) {
      row = { accountId: id, name: record.author, platform: record.source, profileUrl: record.profileUrl || record.url, sourceIds: [], currentSourceIds: [], requestEvidence: [], current: false, relationship: 'requester', buyerStatus: 'unverified' };
      byAccount.set(id, row);
    }
    row.sourceIds.push(record.id); if (current) row.currentSourceIds.push(record.id);
    row.current ||= current; row.requestEvidence.push(evidence(record));
  }
  return [...byAccount.values()].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.requestEvidence[0].date) - Date.parse(a.requestEvidence[0].date) || a.accountId.localeCompare(b.accountId));
}

/** One candidate is one reviewed problem. Neighboring signals never contribute demand. */
export function opportunityCandidates(corpus, { query = '', limit = 16, now = Date.now() } = {}) {
  const timestamp = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now);
  if (!Number.isFinite(timestamp)) throw new TypeError('Opportunity ranking requires a valid current date');
  const cutoff = timestamp - YEAR, records = Array.isArray(corpus?.records) ? corpus.records : [];
  const byId = new Map(records.map(record => [record.id, record]));
  const queryTerms = terms(query), candidates = [];
  for (const signal of corpus?.signals || []) {
    if (!signal?.id || signal.reviewed !== true || signal.confidence !== undefined && signal.confidence < .65 || signal.audit?.status === 'failed') continue;
    const members = requestRecords(distinct(signal.sourceIds || []).map(id => byId.get(id)).filter(record => record?.problemAnalysis?.classification === 'request' && record.authorId && Date.parse(record.date) <= timestamp)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.id.localeCompare(b.id));
    if (!members.length) continue;
    const current = members.filter(record => Date.parse(record.date) >= cutoff), currentAccounts = new Set(current.map(accountKey));
    const allAccounts = new Set(members.map(accountKey));
    const threads = distinct(current.map(record => canonicalSourceUrl(record.threadUrl || record.url)));
    const allThreads = distinct(members.map(record => canonicalSourceUrl(record.threadUrl || record.url)));
    const platforms = distinct(current.map(record => record.source)), allPlatforms = distinct(members.map(record => record.source));
    const repositories = distinct(current.map(repository)), allRepositories = distinct(members.map(repository));
    const meaning = normalize(`${signal.workflow || ''} ${signal.problem || ''} ${signal.desiredOutcome || signal.label || ''}`);
    const rankMembers = current.length ? current : members;
    const ownQuotes = rankMembers.map(record => record.request.quote).join('\n');
    const searchAccounts = new Set(rankMembers.filter(record => PRODUCT_SEARCH.test(record.request.quote)).map(accountKey)).size;
    const maintainerAccounts = new Set(rankMembers.filter(record => record.problemAnalysis.requesterRole === 'maintainer').map(accountKey)).size;
    const rankAccountCount = new Set(rankMembers.map(accountKey)).size;
    const maintenance = MAINTENANCE.test(meaning) || rankMembers.filter(record => MAINTENANCE.test(record.request.quote)).length >= Math.max(1, rankMembers.length * .6);
    const narrowFeature = NARROW_FEATURE.test(meaning) || rankMembers.filter(record => NARROW_FEATURE.test(record.request.quote)).length >= Math.max(1, rankMembers.length * .6);
    const oneProduct = allRepositories.length === 1 && members.every(record => record.source === 'github');
    const recurringWorkflow = REPEATED_JOB.test(signal.workflow || signal.desiredOutcome || '');
    const portableJob = allRepositories.length >= 2 || allPlatforms.length >= 2 || searchAccounts >= 2;
    const isolated = maintenance || (BUG_CONFIG.test(meaning) && (allAccounts.size <= 3 || allThreads.length === 1));
    const classification = isolated ? 'isolated-fix' : narrowFeature || oneProduct || maintainerAccounts >= Math.max(1, rankAccountCount * .6) ? 'product-feature' : recurringWorkflow && allAccounts.size >= 3 && allThreads.length >= 2 && portableJob ? 'product-opportunity' : allAccounts.size >= 2 ? 'product-feature' : 'isolated-fix';
    const membershipAudited = ['verified', 'partial'].includes(signal.audit?.status);
    const status = !currentAccounts.size ? 'historical' : classification === 'product-opportunity' && currentAccounts.size >= 10 && threads.length >= 3 && membershipAudited ? 'ready' : 'early';
    const matchText = `${signal.label} ${meaning} ${ownQuotes}`.toLowerCase();
    const matchScore = queryTerms.filter(term => matchText.includes(term)).length;
    if (queryTerms.length && !matchScore) continue;
    const payment = bucket(current, PAYMENT, 'explicit-payment-language');
    const workarounds = bucket(current, WORKAROUND, 'manual-or-workaround-language');
    const alternativeSeeking = bucket(current, ALTERNATIVE_SEARCH, 'alternative-seeking-language');
    const constraints = bucket(current, CONSTRAINT, 'constraint-language');
    const existingAlternatives = members.flatMap(record => contextualQuotes(record, ALTERNATIVE_CONTEXT).map(quote => ({ ...evidence(record, quote, 'requester-alternative-context'), contributesToDemand: false }))).slice(0, 20);
    const firstCustomers = cohort(members, cutoff);
    const reasons = [`${currentAccounts.size} distinct public accounts in the last 365 days across ${threads.length} threads.`, `${allAccounts.size} accounts across all recorded dates.`];
    if (repositories.length >= 2) reasons.push(`The same reviewed job appears in ${repositories.length} repositories.`);
    if (oneProduct) reasons.push(`Every request is in ${allRepositories[0]}; evidence concerns that product.`);
    if (maintenance) reasons.push('Evidence concerns maintenance, compatibility or a specific repair.');
    else if (narrowFeature) reasons.push('The requested change is a bounded product feature.');
    else if (classification === 'product-opportunity') reasons.push('Repeated workflow evidence spans products, platforms or people seeking alternatives.');
    if (status === 'historical') reasons.push('The current window has no active requester evidence.');
    else if (classification === 'product-opportunity' && currentAccounts.size >= 10 && threads.length >= 3 && !membershipAudited) reasons.push('Same-problem membership has not passed the independent large-group audit.');
    else if (status !== 'ready') reasons.push(classification === 'product-opportunity' ? 'Fewer than 10 recent requesters or fewer than 3 independent threads.' : 'Current evidence supports a feature or repair hypothesis.');
    const score = (classification === 'product-opportunity' ? 120 : classification === 'product-feature' ? 25 : 0) + (status === 'ready' ? 35 : 0) + Math.min(currentAccounts.size, 50) * 2 + Math.min(threads.length, 15) + Math.min(repositories.length, 5) * 6 + Math.min(platforms.length, 4) * 4 + Math.min(searchAccounts, 10) * 2 + Math.min(payment.accountCount, 5) * 3 + Math.min(workarounds.accountCount, 8) - (status === 'historical' ? 90 : 0);
    candidates.push({
      id: `opportunity:${signal.id}`, problemId: signal.id, problemIds: [signal.id], label: signal.label,
      audience: signal.audience || '', workflow: signal.workflow || '', problem: signal.problem || '', desiredOutcome: signal.desiredOutcome || '',
      sourceIds: members.map(record => record.id), currentSourceIds: current.map(record => record.id),
      requesterCount: currentAccounts.size, currentRequesterCount: currentAccounts.size, allTimeCount: allAccounts.size,
      historicalRequesterCount: [...allAccounts].filter(id => !currentAccounts.has(id)).length,
      archiveRequesterCount: new Set(current.filter(record => record.origin === 'dataset').map(accountKey)).size,
      threadCount: threads.length, allTimeThreadCount: allThreads.length, platforms, allTimePlatforms: allPlatforms, repositories, allTimeRepositories: allRepositories,
      communities: distinct(current.map(record => record.community)), recurringWorkflow, classification, status, reasons, score, matchScore,
      firstCustomerCohort: firstCustomers.slice(0, 40), cohortCount: firstCustomers.length, cohortTruncated: firstCustomers.length > 40,
      evidence: { payment, workarounds, alternativeSeeking, constraints, existingAlternatives },
      counterEvidence: [],
      interpretation: { membership: 'reviewed-same-problem', businessClassification: 'deterministic-heuristic', buyerStatus: 'unverified', paymentMeaning: 'Literal requester language; price, budget authority and purchase intent remain unverified.' },
      asOf: new Date(timestamp).toISOString(), windowDays: 365,
    });
  }
  const selected = candidates.sort((a, b) => b.matchScore - a.matchScore || b.score - a.score || b.requesterCount - a.requesterCount || a.problemId.localeCompare(b.problemId)).slice(0, Math.max(1, Math.min(100, Math.floor(Number(limit) || 16))));
  for (const candidate of selected) {
    candidate.counterEvidence = relatedContext(candidate, records, new Set(candidate.sourceIds), timestamp);
    // A short extraction quote may omit a useful payment or workaround sentence.
    // Expose additional literal context for review, without inferring intent
    // or counting the same language twice.
    const members = candidate.currentSourceIds.map(id => byId.get(id));
    candidate.evidence.sourceContext = Object.fromEntries([
      ['payment', PAYMENT], ['workarounds', WORKAROUND], ['alternativeSeeking', ALTERNATIVE_SEARCH], ['constraints', CONSTRAINT],
    ].map(([kind, pattern]) => [kind, members.flatMap(record => contextualQuotes(record, pattern)
      .filter(quote => !candidate.evidence[kind].evidence.some(row => row.sourceId === record.id && row.quote === quote))
      .map(quote => ({ ...evidence(record, quote, `${kind}-context`), requiresContextReview: true, contributesToDemand: false }))).slice(0, 16)]));
  }
  return selected;
}
