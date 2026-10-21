// Progressive enhancement for the feed: star/hide without a page reload,
// and highlight deadlines in the next week. Everything works without it.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('.card [data-action]');
  if (!button) return;
  const card = button.closest('.card');
  const csrf = button.closest('[data-csrf]')?.dataset.csrf;
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

for (const el of document.querySelectorAll('[data-closes]')) {
  const days = (Date.parse(el.dataset.closes) - Date.now()) / 864e5;
  if (days < 7) el.classList.add('soon');
}
