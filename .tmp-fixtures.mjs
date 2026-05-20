import { initDatabase, getUser } from '/app/src/database.js';
await initDatabase();
const u = await getUser('douek.renato@gmail.com');
const key = u.football_api_key;
const headers = { 'x-apisports-key': key };

// 1. Status (pra ver requests usados)
const s = await (await fetch('https://v3.football.api-sports.io/status', { headers })).json();
console.log('Plano:', s.response?.subscription?.plan, '| Requests:', JSON.stringify(s.response?.requests));

// 2. Fixtures next=5 (igual o bot faz)
console.log('\n--- /fixtures?team=126&next=5 ---');
const f = await (await fetch('https://v3.football.api-sports.io/fixtures?team=126&next=5', { headers })).json();
console.log('HTTP results:', f.results, '| errors:', JSON.stringify(f.errors));
console.log('Response:', JSON.stringify(f.response?.slice(0, 2), null, 2).slice(0, 1500));

// 3. Fixtures por season (Brasileirao 2026)
console.log('\n--- /fixtures?team=126&season=2026 ---');
const f2 = await (await fetch('https://v3.football.api-sports.io/fixtures?team=126&season=2026', { headers })).json();
console.log('HTTP results:', f2.results, '| errors:', JSON.stringify(f2.errors));
if (f2.response?.length) {
  console.log('Total na temporada 2026:', f2.response.length);
  console.log('Primeiros 3:');
  f2.response.slice(0, 3).forEach(item => {
    console.log(`  - ${item.fixture?.date} | ${item.teams?.home?.name} x ${item.teams?.away?.name} | ${item.fixture?.status?.short} | ${item.league?.name}`);
  });
}
