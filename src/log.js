// Small levelled logger. Writes to stdout/stderr so Docker or journald keeps
// it. LOG_FORMAT=json gives one JSON object per line for log shippers.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const format = () => process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'text');
const threshold = () => LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function write(level, args) {
  if (LEVELS[level] < threshold()) return;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  // A trailing plain object is treated as structured fields.
  const last = args.at(-1);
  const fields = last && typeof last === 'object' && !(last instanceof Error) && !Array.isArray(last) ? args.pop() : {};
  const msg = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
  if (format() === 'json') {
    stream(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  } else {
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    stream(`${new Date().toISOString()} ${level.toUpperCase()} ${msg}${extra}`);
  }
}

export const log = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
};
