// robots.txt parsing and matching (RFC 9309): the most specific user-agent
// group applies, and within it the longest matching rule wins, with Allow
// beating Disallow on a tie. Supports * and $ in paths, and Crawl-delay.

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay' && Number.isFinite(Number(value))) {
      current.crawlDelay = Number(value);
    }
  }
  return groups;
}

function pathRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

// Returns { allowed, crawlDelay } for a product token such as "BidFinder".
export function robotsDecision(groups, agent, path) {
  const token = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  let crawlDelay = null;
  for (const g of chosen) {
    if (g.crawlDelay != null) crawlDelay = Math.max(crawlDelay ?? 0, g.crawlDelay);
    for (const rule of g.rules) {
      if (!pathRegex(rule.path).test(path)) continue;
      if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
    }
  }
  return { allowed: best ? best.allow : true, crawlDelay };
}
