export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { prompt, apiKey, topic } = req.body;
  if (!prompt || !apiKey) return res.status(400).json({ error: 'Faltan parámetros' });
  if (!apiKey.startsWith('gsk_')) return res.status(401).json({ error: 'API Key inválida. Debe empezar por gsk_' });

  // ── 1. CONSTRUIR MÚLTIPLES BÚSQUEDAS PARA MAYOR COBERTURA ──────────
  const baseTopic = (topic || 'Liga BetPlay Colombia').trim();

  // Generamos hasta 3 variantes de búsqueda para cruzar resultados
  const searchQueries = [
    `${baseTopic} 2026`,
    `Liga BetPlay Colombia noticias hoy 2026`,
  ];

  // Si el tema menciona un equipo específico, agregamos búsqueda directa
  const teamKeywords = [
    'nacional', 'millonarios', 'medellin', 'medellín', 'america', 'santa fe',
    'junior', 'cali', 'tolima', 'bucaramanga', 'pereira', 'once caldas',
    'envigado', 'pasto', 'jaguares', 'aguilas', 'águilas', 'fortaleza', 'llaneros'
  ];
  const mentionedTeam = teamKeywords.find(k => baseTopic.toLowerCase().includes(k));
  if (mentionedTeam) {
    searchQueries.unshift(`${mentionedTeam} futbol colombia 2026`);
  }

  // ── 2. RECOPILAR NOTICIAS REALES DE GOOGLE NEWS RSS ────────────────
  let allNoticias = [];
  let articleLinks = [];
  let seenTitles = new Set();

  for (const query of searchQueries) {
    try {
      const encoded = encodeURIComponent(query);
      const rssUrl = `https://news.google.com/rss/search?q=${encoded}&hl=es-419&gl=CO&ceid=CO:es-419`;
      const rssRes = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      });
      if (!rssRes.ok) continue;
      const rssText = await rssRes.text();

      const items = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5);

      for (const m of items) {
        const title = (
          m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
          m[1].match(/<title>(.*?)<\/title>/)
        )?.[1]?.trim() || '';

        if (!title || seenTitles.has(title.toLowerCase())) continue;
        seenTitles.add(title.toLowerCase());

        const pubDate = m[1].match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || '';
        const source  = m[1].match(/<source[^>]*>(.*?)<\/source>/)?.[1]?.trim() || '';
        const link    = (
          m[1].match(/<link>(.*?)<\/link>/) ||
          m[1].match(/<guid[^>]*>(.*?)<\/guid>/)
        )?.[1]?.trim() || '';

        if (link) articleLinks.push(link);

        allNoticias.push({
          title,
          source,
          pubDate,
          link,
          snippet: '',
        });
      }
    } catch (_) {}
  }

  // ── 3. EXTRAER IMAGEN Y EXTRACTO DEL TEXTO DE LOS ARTÍCULOS ────────
  let newsImageUrl = null;

  for (const noticia of allNoticias.slice(0, 4)) {
    if (newsImageUrl && noticia.snippet) break;
    if (!noticia.link) continue;
    try {
      const pageRes = await fetch(noticia.link, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
      });
      if (!pageRes.ok) continue;
      const html = await pageRes.text();

      // Imagen Open Graph
      if (!newsImageUrl) {
        const ogImage =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
          html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)?.[1];

        if (
          ogImage &&
          ogImage.startsWith('http') &&
          !ogImage.toLowerCase().includes('logo') &&
          !ogImage.toLowerCase().includes('icon') &&
          !ogImage.toLowerCase().includes('favicon')
        ) {
          newsImageUrl = ogImage;
        }
      }

      // Extracto de texto del cuerpo del artículo (primeros ~500 chars útiles)
      if (!noticia.snippet) {
        // Eliminar scripts, estilos y HTML
        const plainText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        // Buscamos frases que parezcan periodísticas (más de 60 chars, sin URLs)
        const sentences = plainText
          .split(/[.!?]/)
          .map(s => s.trim())
          .filter(s => s.length > 60 && !s.includes('http') && !s.includes('{') && !/^\s*\d+\s*$/.test(s));

        if (sentences.length > 0) {
          noticia.snippet = sentences.slice(0, 3).join('. ').substring(0, 500);
        }
      }
    } catch (_) {}
  }

  // ── 4. CONSTRUIR EL CONTEXTO PERIODÍSTICO VERIFICADO ──────────────
  let newsContext = '';
  if (allNoticias.length > 0) {
    const lineas = allNoticias.slice(0, 6).map(n => {
      let linea = `• "${n.title}"`;
      if (n.source) linea += ` — Fuente: ${n.source}`;
      if (n.pubDate) linea += ` (${n.pubDate})`;
      if (n.snippet) linea += `\n  Extracto: ${n.snippet}`;
      return linea;
    });
    newsContext = `\n\n═══ NOTICIAS VERIFICADAS DE GOOGLE NEWS — COLOMBIA 2026 ═══\n${lineas.join('\n\n')}\n═══════════════════════════════════════════════════════════\n\nUSA ESTAS NOTICIAS COMO BASE EXCLUSIVA. No inventes hechos que no aparezcan aquí.`;
  } else {
    newsContext = `\n\nNOTA: No se encontraron noticias recientes verificadas. Redacta con base en contexto general de la Liga BetPlay 2026, siendo explícito sobre lo que es análisis y lo que es información confirmada.`;
  }

  // ── 5. LLAMAR A GROQ CON SYSTEM PROMPT Y CONTEXTO VERIFICADO ───────
  const systemPrompt = `Eres un periodista deportivo colombiano de alto nivel, especialista en fútbol profesional y Liga BetPlay. Tienes criterio editorial propio, voz analítica y capacidad de contextualizar más allá de lo obvio.

REGLAS ABSOLUTAS:
1. NUNCA inventes goles, resultados, fichajes, lesiones, declaraciones ni estadísticas que no estén en las noticias proporcionadas.
2. Si no hay suficiente información verificada, sé transparente: contextualiza con historia del equipo o la competición, pero señala claramente qué es contexto y qué es noticia confirmada.
3. Ortografía y gramática perfectas: tildes obligatorias (también en mayúsculas), signos de puntuación correctos, signos de apertura ¿¡ cuando corresponda.
4. Redacta con voz propia, no como un resumen plano. Aporta perspectiva, destaca lo que importa, explica el porqué de la relevancia.
5. Evita frases gastadas y obvias como "en un emocionante encuentro", "el equipo demostró carácter", "la afición vibró". Sé específico y original.
6. El año vigente es 2026. Cualquier referencia temporal debe corresponder a la temporada 2026 de la Liga BetPlay.
7. Cuando el tema involucre un equipo, usa los colores y la identidad de ese club en el registro emocional del texto (ej: si es del Medellín, el tono puede resonar con la pasión roja y azul; si es del Nacional, con el verde verdolaga).
8. Devuelve ÚNICAMENTE el JSON indicado, sin backticks, sin texto antes ni después.`;

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
        temperature: 0.65,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: enrichedPrompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      return res.status(groqRes.status).json({
        error: err.error?.message || `Error Groq: HTTP ${groqRes.status}`,
      });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({ text, newsImageUrl });

  } catch (e) {
    return res.status(500).json({ error: 'Error del servidor: ' + e.message });
  }
}
