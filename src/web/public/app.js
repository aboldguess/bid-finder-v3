// Progressive enhancement. Every page works without this file.

// Star and hide from a list without reloading.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('.card [data-action]');
  if (!button) return;
  const card = button.closest('.card');
  const csrf = button.closest('[data-csrf]')?.dataset.csrf;
  if (!csrf) return;
  const field = button.dataset.action;
  const next = button.getAttribute('aria-pressed') !== 'true';
  const res = await fetch(`/o/${card.dataset.id}/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ [field]: next }),
  });
  if (!res.ok) return;
  button.setAttribute('aria-pressed', String(next));
  if (field === 'starred') card.classList.toggle('starred', next);
  if (field === 'hidden' && next) card.classList.add('gone');
});

// Ask before destructive actions.
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-confirm]');
  if (el && !window.confirm(el.dataset.confirm)) event.preventDefault();
});

// Profile presets: add a discipline's keywords and CPV categories.
for (const chip of document.querySelectorAll('[data-preset]')) {
  chip.addEventListener('click', () => {
    const merge = (id, extra) => {
      const box = document.getElementById(id);
      const have = box.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
      const lower = new Set(have.map((s) => s.toLowerCase()));
      for (const item of extra.split('\n')) if (item && !lower.has(item.toLowerCase())) have.push(item);
      box.value = have.join('\n');
      box.rows = Math.min(14, Math.max(box.rows, have.length + 1));
    };
    merge('keywords', chip.dataset.keywords);
    merge('cpv_codes', chip.dataset.cpv);
    chip.classList.add('on');
  });
}

// Credential form: show the fields for the chosen kind.
for (const form of document.querySelectorAll('[data-credential-form]')) {
  const select = form.querySelector('select[name=kind]');
  const sync = () => form.querySelectorAll('[data-kind]').forEach((row) => { row.hidden = row.dataset.kind !== select.value; });
  select.addEventListener('change', sync);
  sync();
}

// Close the user menu when clicking elsewhere.
document.addEventListener('click', (event) => {
  for (const menu of document.querySelectorAll('details.usermenu[open]')) if (!menu.contains(event.target)) menu.open = false;
});

// Welcome page: as choices change, show how many open opportunities match and the best few.
const preview = document.querySelector('[data-preview]');
if (preview) {
  const form = document.getElementById('welcome-form');
  const totalEl = preview.querySelector('[data-preview-total]');
  const labelEl = preview.querySelector('[data-preview-label]');
  const list = preview.querySelector('[data-preview-list]');
  let timer;
  let seq = 0;
  const refresh = async () => {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (k !== '_csrf') params.append(k, v);
    const mine = ++seq;
    preview.classList.add('loading');
    try {
      const res = await fetch(`${preview.dataset.preview}?${params}`, { headers: { accept: 'application/json' } });
      const data = await res.json();
      if (mine !== seq) return;
      const chosen = params.getAll('presets').length || (params.get('keywords') || '').trim();
      totalEl.textContent = chosen ? data.total.toLocaleString('en-GB') : '–';
      labelEl.textContent = !chosen ? 'pick a kind of work to see your matches' : data.total === 1 ? 'open opportunity matches' : 'open opportunities match';
      list.replaceChildren(...data.top.map((o) => {
        const li = document.createElement('li');
        const title = document.createElement('span');
        title.textContent = o.title;
        const meta = document.createElement('small');
        meta.textContent = [o.buyer, o.closes_at ? `closes ${new Date(o.closes_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''].filter(Boolean).join(' · ');
        li.append(title, meta);
        return li;
      }));
    } catch { /* the preview is a nicety; the form still works */ } finally {
      if (mine === seq) preview.classList.remove('loading');
    }
  };
  form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(refresh, 150); });
  form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 400); });
}
