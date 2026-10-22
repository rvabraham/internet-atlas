import { EXTRACTION_SCHEMA, GROUP_REVIEW_SCHEMA, buildExtractionPrompt, buildGroupReviewPrompt, validateExtractions } from './problems.mjs';

const fullExtraction = EXTRACTION_SCHEMA.properties.extractions.items;
const fullGroup = GROUP_REVIEW_SCHEMA.properties.groups.items;
const nonrequestClasses = fullExtraction.properties.classification.enum.filter(value => value !== 'request');
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = items => ({ type: 'array', maxItems: 2000, items });
export const COMPACT_EXTRACTION_SCHEMA = object({
  requests: array({ ...fullExtraction, properties: { ...fullExtraction.properties, classification: { type: 'string', enum: ['request'] } } }),
  other: array(object({
    sourceId: fullExtraction.properties.sourceId,
    classification: { type: 'string', enum: nonrequestClasses },
    evidenceQuote: { ...fullExtraction.properties.evidenceQuote, maxLength: 350 },
    confidence: fullExtraction.properties.confidence,
  })),
});
export const COMPACT_GROUP_REVIEW_SCHEMA = object({
  groups: array(fullGroup),
  singletons: array(fullExtraction.properties.sourceId),
  excluded: GROUP_REVIEW_SCHEMA.properties.excluded,
});

function envelope(output, keys) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).length !== keys.length || Object.keys(output).some(key => !keys.includes(key)) || keys.some(key => !Array.isArray(output[key]))) throw new Error('Compact model output has an invalid shape.');
}

export function buildCompactExtractionPrompt(records) {
  return `WIRE FORMAT: Use the supplied compact schema. Apply every classification, evidence and scope rule below unchanged. Put genuine requests in requests, with every full extraction field. Put all other classifications in other, using only sourceId, classification, a short literal evidenceQuote and your actual confidence. Omitted nonrequest descriptors are empty by definition; do not output them. Never infer evidence or confidence. Keep one verbatim clause that supports each nonrequest classification, at most 350 characters. Account for every supplied sourceId exactly once across requests and other. This changes only the response encoding, not the classification rules.

${buildExtractionPrompt(records)}`;
}

export function normalizeCompactExtractions(output) {
  envelope(output, ['requests', 'other']);
  if (output.requests.length + output.other.length > 2000) throw new Error('Compact extraction output is too large.');
  for (const row of output.requests) if (row?.classification !== 'request') throw new Error('Only request classifications belong in compact requests.');
  const other = output.other.map(row => {
    const keys = ['sourceId', 'classification', 'evidenceQuote', 'confidence'];
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(row, key)) || !nonrequestClasses.includes(row.classification)) throw new Error('Compact nonrequest output has an invalid shape.');
    return { sourceId: row.sourceId, classification: row.classification, evidenceQuote: row.evidenceQuote, confidence: row.confidence, audience: '', workflow: '', problem: '', desiredOutcome: '', requesterRole: 'unknown', proposedProblemKey: null };
  });
  return { extractions: [...output.requests, ...other] };
}

export function buildCompactGroupReviewPrompt(candidateGroups, records, extractions) {
  return `WIRE FORMAT: Use the supplied compact schema. Apply every grouping, evidence and exclusion rule below unchanged. Return full group objects in groups only when a coherent problem contains multiple sourceIds. For a valid request that should remain its own problem, put its sourceId in singletons instead of repeating its existing validated descriptors. Return genuine exclusions in excluded with the usual sourceId and reason. Account for every candidate sourceId exactly once across groups, singletons and excluded. Do not add counts. This changes only response encoding, not semantic membership or confidence rules.

${buildGroupReviewPrompt(candidateGroups, records, extractions)}`;
}

function labelFor(value = '') {
  return value.length <= 95 ? value : `${value.slice(0, 92).replace(/\s+\S*$/, '')}…`;
}

export function normalizeCompactGroupReview(output, candidateGroups, records, extractions) {
  envelope(output, ['groups', 'singletons', 'excluded']);
  const fields = Object.keys(fullExtraction.properties);
  const rows = (Array.isArray(extractions) ? extractions : extractions?.accepted || []).map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
  const validated = validateExtractions({ extractions: rows }, records);
  const requests = new Map(validated.accepted.filter(row => row.classification === 'request').map(row => [row.sourceId, row]));
  const singletonGroups = output.singletons.map(sourceId => {
    const extraction = requests.get(sourceId);
    // Unknown IDs and nonrequests retain invalid descriptors so the existing
    // group validator rejects them, including assignment and missing-ID errors.
    return {
      candidateIds: candidateGroups.filter(group => group.sourceIds.includes(sourceId)).map(group => group.id),
      sourceIds: [sourceId], label: labelFor(extraction?.desiredOutcome), audience: extraction?.audience || '',
      workflow: extraction?.workflow || '', problem: extraction?.problem || '', desiredOutcome: extraction?.desiredOutcome || '',
      confidence: extraction?.confidence ?? 0, coherence: 'coherent',
    };
  });
  return { groups: [...output.groups, ...singletonGroups], excluded: output.excluded };
}
