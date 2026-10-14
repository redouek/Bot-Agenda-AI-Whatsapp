import { initDatabase, getUser } from '/app/src/database.js';
await initDatabase();
const u = await getUser('douek.renato@gmail.com');
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
