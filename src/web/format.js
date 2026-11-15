// Formatting helpers available to every view as `fmt`.
const SYMBOLS = { GBP: '£', EUR: '€', USD: '$' };
const tz = 'Europe/London';

function compact(n) {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}bn`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Number(n).toLocaleString('en-GB');
}

export const fmt = {
  money: (n, currency = 'GBP') => `${SYMBOLS[currency] ?? `${currency} `}${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`,
  // Short value for a card: "£1.2m", "up to £250k", or the source's own wording.
  value(o) {
    if (o.award_text) return o.award_text;
    if (o.award_max == null) return '';
    const s = SYMBOLS[o.currency] ?? `${o.currency} `;
    return o.type === 'grant' ? `up to ${s}${compact(o.award_max)}` : `${s}${compact(o.award_max)}`;
  },
  date: (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }),
  dateTime: (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz }),
  // SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or an ISO string, as local date and time.
  stamp: (s) => (s ? fmt.dateTime(/T/.test(s) ? s : `${s.replace(' ', 'T')}Z`) : ''),
  daysLeft(iso, now = Date.now()) {
    const d = Math.ceil((Date.parse(iso) - now) / 864e5);
    return d <= 0 ? 'today' : d === 1 ? '1 day left' : `${d} days left`;
  },
  soon: (iso, now = Date.now()) => Date.parse(iso) - now < 7 * 864e5,
  band: (score) => (score >= 60 ? 'high' : score >= 30 ? 'mid' : 'low'),
  every(minutes) {
    if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? 'Hourly' : `Every ${minutes / 60} hours`;
    return `Every ${minutes} min`;
  },
};
