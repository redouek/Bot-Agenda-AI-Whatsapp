import { initDatabase, getUser } from '/app/src/database.js';
await initDatabase();
// Uso: DUMP_USER=<email> node .tmp-dump.mjs
const email = process.env.DUMP_USER;
if (!email) { console.error('Defina DUMP_USER com o e-mail do usuario.'); process.exit(1); }
const u = await getUser(email);
const headers = { 'X-Auth-Token': u.football_api_key };

// Lista as competicoes que queremos pegar times
const codes = ['BSA', 'CLI', 'WC', 'CL', 'PL', 'PD', 'BL1', 'SA', 'FL1'];

for (const code of codes) {
  console.log(`\n=== ${code} ===`);
  const j = await (await fetch(`https://api.football-data.org/v4/competitions/${code}/teams`, { headers })).json();
  for (const t of (j.teams || [])) {
    console.log(`  ${t.id} | ${t.name}${t.shortName && t.shortName !== t.name ? ' (' + t.shortName + ')' : ''} | tla=${t.tla}`);
  }
  await new Promise(r => setTimeout(r, 6500));
}
