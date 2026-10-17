// Falešný poskytovatel AI kompatibilní s OpenAI pro ruční zkoušení asistenta bez skutečného klíče.
// Spuštění: node scripts/fake-ai.mjs [port]. V nastavení: poskytovatel „vlastní“, adresa http://localhost:3999/v1.
// Na první zprávu v konverzaci navrhne změnu podle textu (číslo v textu = sleva v obchodě), pak jen odpoví textem.
import http from 'node:http';

const port = Number(process.argv[2] ?? 3999);
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const msgs = j.messages ?? [];
      const last = msgs[msgs.length - 1];
      const user = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const num = user.match(/\d+/)?.[0];
      let message;
      if (last?.role === 'tool') {
        const r = JSON.parse(last.content || '{}');
        message = { role: 'assistant', content: r.ok ? `Navrhl jsem změnu, potvrď ji prosím. (${r.summary ?? ''})` : `Nešlo to: ${(r.denied ?? [r.error]).join('; ')}` };
      } else if (num && (j.tools ?? []).some((t) => t.function?.name === 'propose_settings_change')) {
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'propose_settings_change', arguments: JSON.stringify({ target: { kind: 'global' }, changes: [{ key: 'cosmetics.discountPercent', value: num }] }) } }] };
      } else {
        message = { role: 'assistant', content: `Falešný asistent: dostal jsem „${user}“. Napiš číslo a navrhnu slevu v obchodě.` };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }], usage: { total_tokens: 12 } }));
    });
  })
  .listen(port, () => console.log(`falešný poskytovatel AI na http://localhost:${port}/v1`));
