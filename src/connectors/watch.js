// "Watch a body": one source that follows a single organisation (Network
// Rail, NASA, the US Department of Transportation...) across the portals it
// publishes on. Each part is another connector with fixed settings; results
// are kept only where the buyer or funder matches.
import { log } from '../log.js';
export function watchConnector({ key, name, homepage, parts, match, intervalMinutes = 720, enabledByDefault = false }) {
  return {
    key,
    name,
    type: parts.every((p) => p.connector.type === 'grant') ? 'grant' : 'tender',
    homepage,
    access: `Watches ${parts.map((p) => p.connector.name).join(', ')}`,
    intervalMinutes,
    minDelayMs: Math.max(...parts.map((p) => p.connector.minDelayMs ?? 1000)),
    respectRobots: parts.some((p) => p.connector.respectRobots),
    enabledByDefault,
    parts,
    async fetch(ctx = {}) {
      const all = new Map();
      const errors = [];
      for (const { connector, config = {}, filter = match } of parts) {
        try {
          const items = await connector.fetch({ ...ctx, config });
          for (const item of items) {
            if (filter && !filter.test(`${item.funder} ${item.eligibility}`)) continue;
            all.set(`${connector.key}:${item.external_id}`, { ...item, external_id: `${connector.key}:${item.external_id}`, type: connector.type });
          }
        } catch (err) {
          errors.push(`${connector.name}: ${err.message}`);
        }
      }
      // One portal being down should not hide what the others found.
      if (errors.length === parts.length) throw new Error(errors.join('; '));
      if (errors.length) log.warn(`${name}: ${errors.join('; ')}`);
      return [...all.values()];
    },
  };
}
