// Minimal timestamped logger. Writes to stdout so systemd/journald captures it.
const fmt = (level, args) => [new Date().toISOString(), level, ...args];

export const log = {
  info: (...args) => console.log(...fmt('INFO', args)),
  warn: (...args) => console.warn(...fmt('WARN', args)),
  error: (...args) => console.error(...fmt('ERROR', args)),
};
