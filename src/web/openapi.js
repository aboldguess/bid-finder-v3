// OpenAPI 3.1 description of the JSON API, served at /api/v1/openapi.json
// and rendered on the in-app API page.
import { config } from '../config.js';
import { STAGES } from '../match/feed.js';

const filterParams = [
  ['q', 'Full-text search across title, summary and buyer.', 'string'],
  ['view', 'matches (default: scored at or above your threshold), all, starred, hidden or pipeline.', 'string'],
  ['type', 'tender or grant.', 'string'],
  ['source', 'Source key, as listed by /sources.', 'string'],
  ['cpv', 'CPV code or leading digits, comma-separated. 713 matches every 713xxxxx code.', 'string'],
  ['country', 'Two-letter country code, for example GB.', 'string'],
  ['min_value', 'Minimum contract value.', 'number'],
  ['min_score', 'Override your profile\'s minimum fit score (0 to 100).', 'integer'],
  ['sort', 'score (default), deadline, newest or value.', 'string'],
  ['since', 'Only opportunities first seen after this ISO date or date-time.', 'string'],
  ['limit', 'Page size, up to 200. Default 50.', 'integer'],
  ['offset', 'Number of items to skip.', 'integer'],
].map(([name, description, type]) => ({ name, in: 'query', description, schema: { type } }));

const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer' } };
const json = (schema) => ({ content: { 'application/json': { schema } } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const list = (name) => ({ type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: ref(name) } } });

export const openapi = () => ({
  openapi: '3.1.0',
  info: { title: 'Bid Finder API', version: config.version, description: 'Read and triage opportunities. Create a token on the Account page and send it as a bearer token. Limited to 120 requests a minute per token.' },
  servers: [{ url: `${config.baseUrl}/api/v1` }],
  security: [{ bearer: [] }],
  paths: {
    '/opportunities': { get: { summary: 'List opportunities, scored against your profile', parameters: filterParams, responses: { 200: { description: 'A page of opportunities.', ...json(list('Opportunity')) } } } },
    '/opportunities/{id}': {
      get: { summary: 'Get one opportunity', parameters: [idParam], responses: { 200: { description: 'The opportunity.', ...json(ref('Opportunity')) }, 404: { description: 'Not found.' } } },
      patch: {
        summary: 'Update your triage state for an opportunity', parameters: [idParam],
        requestBody: json({ type: 'object', properties: { starred: { type: 'boolean' }, hidden: { type: 'boolean' }, note: { type: 'string' }, stage: { type: ['string', 'null'], enum: [...STAGES, null] } } }),
        responses: { 200: { description: 'The updated opportunity.', ...json(ref('Opportunity')) } },
      },
    },
    '/saved-searches': { get: { summary: 'List saved searches', responses: { 200: { description: 'Saved searches.' } } } },
    '/saved-searches/{id}/results': { get: { summary: 'Current matches for a saved search', parameters: [idParam], responses: { 200: { description: 'Matching opportunities.', ...json(list('Opportunity')) } } } },
    '/sources': { get: { summary: 'Sources and the outcome of their last run', responses: { 200: { description: 'Sources.' } } } },
    '/sources/{key}/run': { post: { summary: 'Start a run of one source (platform administrators only)', parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { 202: { description: 'Started.' }, 409: { description: 'A run is already in progress.' } } } },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Opportunity: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, source: { type: 'string' }, type: { type: 'string', enum: ['tender', 'grant'] }, title: { type: 'string' }, summary: { type: 'string' },
          buyer: { type: 'string' }, url: { type: 'string', description: 'The notice on the publisher\'s site.' }, app_url: { type: 'string' }, location: { type: 'string' }, country: { type: 'string' },
          cpv_codes: { type: 'array', items: { type: 'string' } }, value: { type: ['number', 'null'] }, value_min: { type: ['number', 'null'] }, currency: { type: 'string' }, notice_type: { type: 'string' },
          published_at: { type: ['string', 'null'] }, opens_at: { type: ['string', 'null'] }, closes_at: { type: ['string', 'null'] }, first_seen_at: { type: 'string' },
          score: { type: 'integer', description: 'Fit against your profile, 0 to 100.' }, reasons: { type: 'array', items: { type: 'string' } },
          starred: { type: 'boolean' }, hidden: { type: 'boolean' }, stage: { type: ['string', 'null'] }, note: { type: 'string' },
        },
      },
    },
  },
});
