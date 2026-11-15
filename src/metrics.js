// Prometheus metrics in the text exposition format, without a client
// library: a few in-process counters plus gauges read from the database.
import { config } from './config.js';

const started = Date.now();
const counters = new Map(); // "name{labels}" -> value

export function inc(name, labels = {}, by = 1) {
  const key = `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '')}"`).join(',')}}`;
  counters.set(key, (counters.get(key) || 0) + by);
}

export function renderMetrics(db) {
  const lines = [];
  const gauge = (name, help, rows) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${value}`);
  };
  gauge('bidfinder_build_info', 'Running version.', [[`{version="${config.version}"}`, 1]]);
  gauge('bidfinder_uptime_seconds', 'Seconds since the process started.', [['', Math.round((Date.now() - started) / 1000)]]);
  const now = new Date().toISOString();
  gauge('bidfinder_opportunities_open', 'Open opportunities by source.',
    db.prepare('SELECT source_key, COUNT(*) AS n FROM opportunities WHERE closes_at IS NULL OR closes_at > ? GROUP BY source_key').all(now).map((r) => [`{source="${r.source_key}"}`, r.n]));
  const sources = db.prepare('SELECT key, enabled, last_run_at, last_status FROM sources').all();
  gauge('bidfinder_source_enabled', 'Whether a source is switched on.', sources.map((s) => [`{source="${s.key}"}`, s.enabled]));
  gauge('bidfinder_source_last_run_success', 'Whether the last run of a source succeeded.', sources.filter((s) => s.last_status).map((s) => [`{source="${s.key}"}`, s.last_status === 'ok' ? 1 : 0]));
  gauge('bidfinder_source_last_run_timestamp_seconds', 'When a source last ran.', sources.filter((s) => s.last_run_at).map((s) => [`{source="${s.key}"}`, Math.round(Date.parse(`${s.last_run_at.replace(' ', 'T')}Z`) / 1000)]));
  gauge('bidfinder_source_runs', 'Source runs in the last 60 days by outcome.',
    db.prepare('SELECT source_key, status, COUNT(*) AS n FROM source_runs GROUP BY source_key, status').all().map((r) => [`{source="${r.source_key}",status="${r.status}"}`, r.n]));
  gauge('bidfinder_alerts', 'Alert deliveries in the last 180 days by channel and outcome.',
    db.prepare('SELECT channel, ok, COUNT(*) AS n FROM alert_log GROUP BY channel, ok').all().map((r) => [`{channel="${r.channel}",ok="${r.ok}"}`, r.n]));
  gauge('bidfinder_users', 'Registered users.', [['', db.prepare('SELECT COUNT(*) AS n FROM users').get().n]]);
  const names = new Set();
  for (const [key, value] of counters) {
    const name = key.slice(0, key.indexOf('{'));
    if (!names.has(name)) { names.add(name); lines.push(`# TYPE ${name} counter`); }
    lines.push(`${key.endsWith('{}') ? name : key} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
