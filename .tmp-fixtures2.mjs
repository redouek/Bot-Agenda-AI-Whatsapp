import { initDatabase, getUser } from '/app/src/database.js';
await initDatabase();
const u = await getUser('douek.renato@gmail.com');
const key = u.football_api_key;
const headers = { 'x-apisports-key': key };

const today = new Date().toISOString().slice(0, 10);
const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

console.log('Hoje:', today, '+30d:', in30);

// 1. by date range
console.log('\n--- /fixtures?team=126&from=hoje&to=+30d ---');
const f1 = await (await fetch(`https://v3.football.api-sports.io/fixtures?team=126&from=${today}&to=${in30}`, { headers })).json();
console.log('results:', f1.results, '| errors:', JSON.stringify(f1.errors));
if (f1.response?.length) f1.response.slice(0, 3).forEach(i => console.log(`  - ${i.fixture?.date} | ${i.teams?.home?.name} x ${i.teams?.away?.name} | ${i.league?.name}`));

// 2. by date single
console.log('\n--- /fixtures?team=126&date=hoje ---');
const f2 = await (await fetch(`https://v3.football.api-sports.io/fixtures?team=126&date=${today}`, { headers })).json();
console.log('results:', f2.results, '| errors:', JSON.stringify(f2.errors));

// 3. live
console.log('\n--- /fixtures?team=126&live=all ---');
const f3 = await (await fetch(`https://v3.football.api-sports.io/fixtures?team=126&live=all`, { headers })).json();
console.log('results:', f3.results, '| errors:', JSON.stringify(f3.errors));

// 4. season 2024 (limite do Free)
console.log('\n--- /fixtures?team=126&season=2024 (Free max) ---');
const f4 = await (await fetch(`https://v3.football.api-sports.io/fixtures?team=126&season=2024`, { headers })).json();
console.log('results:', f4.results, '| errors:', JSON.stringify(f4.errors));
if (f4.response?.length) console.log('  amostra:', f4.response[0]?.fixture?.date, f4.response[0]?.teams?.home?.name, 'x', f4.response[0]?.teams?.away?.name);
