const form = document.getElementById('admin-form');
const feedback = document.getElementById('admin-feedback');

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    for (const [key, value] of Object.entries(config)) {
      const input = form.elements[key];
      if (input && typeof value === 'string' && !value.includes('******')) {
        input.value = value;
      }
    }
    if (!form.elements.OAUTH_REDIRECT_URI.value) {
      form.elements.OAUTH_REDIRECT_URI.value = `${location.origin}/oauth/callback`;
    }
  } catch {}
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (el.name && el.value.trim()) data[el.name] = el.value.trim();
  }

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 4000);
  } catch {
    alert('Nao foi possivel salvar a plataforma.');
  }
});

loadConfig();
