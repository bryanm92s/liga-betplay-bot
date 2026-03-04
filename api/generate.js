export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, apiKey, topic } = req.body;
  if (!prompt || !apiKey) return res.status(400).json({ error: 'Faltan parámetros' });
  if (!apiKey.startsWith('gsk_')) return res.status(401).json({ error: 'API Key inválida. Debe empezar por gsk_' });

  // ── 1. BUSCAR NOTICIAS REALES EN GOOGLE NEWS RSS ──────────
  let newsContext = '';
  let newsImageUrl = null;
  let articleLinks = [];

  try {
    const query = encodeURIComponent((topic || 'Liga BetPlay') + ' 2026');
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=es-419&gl=CO&ceid=CO:es-419`;
    const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rssText = await rssRes.text();

    const items = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6);
    const noticias = items.map(m => {
      const title = (m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || m[1].match(/<title>(.*?)<\/title>/))?.[1] || '';
      const pubDate = (m[1].match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
      const source = (m[1].match(/<source[^>]*>(.*?)<\/source>/))?.[1] || '';
      const link = (m[1].match(/<link>(.*?)<\/link>/) || m[1].match(/<guid[^>]*>(.*?)<\/guid>/))?.[1] || '';
      if (link) articleLinks.push(link);
      return `• ${title}${source ? ` (${source})` : ''}${pubDate ? ` — ${pubDate}` : ''}`;
    }).filter(Boolean);

    if (noticias.length > 0) {
      newsContext = `\n\nNOTICIAS REALES ENCONTRADAS HOY EN GOOGLE NEWS (usalas como base):\n${noticias.join('\n')}`;
    }
  } catch (_) {}

  // ── 2. EXTRAER IMAGEN REAL DEL PRIMER ARTICULO ────────────
  for (const link of articleLinks.slice(0, 3)) {
    if (newsImageUrl) break;
    try {
      const pageRes = await fetch(link, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        redirect: 'follow',
      });
      const html = await pageRes.text();

      const ogImage =
        html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
        html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)?.[1];

      if (ogImage && ogImage.startsWith('http') && !ogImage.includes('logo') && !ogImage.includes('icon')) {
        newsImageUrl = ogImage;
      }
    } catch (_) {}
  }

  // ── 3. LLAMAR A GROQ CON EL CONTEXTO DE NOTICIAS REALES ──
  try {
    const enrichedPrompt = prompt + newsContext;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2048,
        messages: [{ role: 'user', content: enrichedPrompt }],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      return res.status(groqRes.status).json({ error: err.error?.message || `Error Groq: HTTP ${groqRes.status}` });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text, newsImageUrl });

  } catch (e) {
    return res.status(500).json({ error: 'Error del servidor: ' + e.message });
  }
}
