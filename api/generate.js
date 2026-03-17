export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, apiKey, topic } = req.body;
  if (!prompt || !apiKey) return res.status(400).json({ error: 'Faltan parámetros' });
  if (!apiKey.startsWith('gsk_')) return res.status(401).json({ error: 'API Key inválida. Debe empezar por gsk_' });

  const MAX_AGE_DAYS = 7;
  const now = Date.now();
  const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

  // ─────────────────────────────────────────────────────────
  // UTILIDADES
  // ─────────────────────────────────────────────────────────

  /** Extrae el texto de etiquetas HTML limpias */
  function stripHtml(str) {
    return (str || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#\d+;/g,'').replace(/\s+/g,' ').trim();
  }

  /** Extrae la imagen og de un HTML */
  function extractOgImage(html) {
    return (
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1] ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)?.[1] ||
      null
    );
  }

  /** Extrae párrafos útiles de un HTML */
  function extractBody(html, maxChars = 700) {
    return [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => stripHtml(m[1]))
      .filter(p => p.length > 60)
      .slice(0, 5)
      .join(' ')
      .substring(0, maxChars);
  }

  /** Fetch con timeout */
  async function fetchHtml(url, timeoutMs = 5000) {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  /** Filtra un link por antigüedad y relevancia con "liga betplay 2026" */
  function isRelevant(text) {
    const t = (text || '').toLowerCase();
    return (
      t.includes('betplay') || t.includes('liga') || t.includes('colombian') ||
      t.includes('nacional') || t.includes('millonarios') || t.includes('santa fe') ||
      t.includes('junior') || t.includes('america') || t.includes('cali') ||
      t.includes('bucaramanga') || t.includes('tolima') || t.includes('medellin')
    );
  }

  // ─────────────────────────────────────────────────────────
  // SCRAPERS POR FUENTE
  // ─────────────────────────────────────────────────────────

  const SOURCES = [
    {
      name: 'Win Sports',
      url: 'https://www.winsports.co/noticias',
      linkPattern: /href=["'](\/noticias\/[^"'?#]{10,})["']/gi,
      baseUrl: 'https://www.winsports.co',
    },
    {
      name: 'FutbolRed',
      url: 'https://www.futbolred.com/futbol-colombiano',
      linkPattern: /href=["'](\/futbol-colombiano\/[^"'?#]{10,})["']/gi,
      baseUrl: 'https://www.futbolred.com',
    },
    {
      name: 'ESPN Colombia',
      url: 'https://www.espn.com.co/futbol/liga/_/nombre/col.1/primera-division-de-colombia',
      linkPattern: /href=["'](\/futbol\/[^"'?#]{10,})["']/gi,
      baseUrl: 'https://www.espn.com.co',
    },
    {
      name: 'Claro Sports',
      url: 'https://www.clarosports.com/colombia-home/',
      linkPattern: /href=["']((?:https:\/\/www\.clarosports\.com)?\/[^"'?#]{15,})["']/gi,
      baseUrl: 'https://www.clarosports.com',
    },
  ];

  const allHeadlines = [];  // { title, source, link, body }
  let newsImageUrl = null;

  // ── Scraping en paralelo de los 4 sitios ─────────────────
  await Promise.allSettled(
    SOURCES.map(async (src) => {
      try {
        const html = await fetchHtml(src.url);

        // Recopilar links únicos de artículos
        const rawLinks = new Set();
        let m;
        const re = new RegExp(src.linkPattern.source, src.linkPattern.flags);
        while ((m = re.exec(html)) !== null) {
          const href = m[1].startsWith('http') ? m[1] : src.baseUrl + m[1];
          rawLinks.add(href);
          if (rawLinks.size >= 6) break;
        }

        // Extraer titulares del HTML principal (h2/h3/a con texto)
        const titleTags = [...html.matchAll(/<(?:h[123]|a)[^>]*>([\s\S]*?)<\/(?:h[123]|a)>/gi)]
          .map(t => stripHtml(t[1]))
          .filter(t => t.length > 20 && t.length < 200 && isRelevant(t))
          .slice(0, 6);

        if (titleTags.length > 0) {
          allHeadlines.push(`\n--- ${src.name.toUpperCase()} (${src.url}) ---`);
          titleTags.forEach(t => allHeadlines.push(`• ${t}`));
        }

        // Fetch de los primeros 2 artículos para obtener cuerpo e imagen
        let fetched = 0;
        for (const link of rawLinks) {
          if (fetched >= 2) break;
          try {
            const articleHtml = await fetchHtml(link, 4000);
            const body = extractBody(articleHtml);
            const ogImg = extractOgImage(articleHtml);
            const titleEl = stripHtml(articleHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');

            if (body.length > 100 && isRelevant(body + ' ' + titleEl)) {
              allHeadlines.push(`  ↳ [${src.name}] ${titleEl || link}`);
              allHeadlines.push(`    Extracto: ${body.substring(0, 350)}`);
              fetched++;
            }

            if (!newsImageUrl && ogImg && ogImg.startsWith('http') &&
                !ogImg.includes('logo') && !ogImg.includes('icon')) {
              newsImageUrl = ogImg;
            }
          } catch (_) {}
        }

      } catch (_) {}
    })
  );

  // ── Google News RSS como respaldo/complemento ─────────────
  try {
    const topicClean = (topic || '').replace(/liga betplay/i, '').replace(/2025|2024/g, '').trim();
    const searchQuery = topicClean ? `"Liga BetPlay 2026" ${topicClean}` : '"Liga BetPlay 2026"';
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=es-419&gl=CO&ceid=CO:es-419`;
    const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': UA } });
    const rssText = await rssRes.text();

    const items = [...rssText.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6);
    const googleItems = items.map(m => {
      const title = stripHtml((m[1].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || m[1].match(/<title>(.*?)<\/title>/))?.[1] || '');
      const pubDateStr = (m[1].match(/<pubDate>(.*?)<\/pubDate>/))?.[1] || '';
      const source = stripHtml((m[1].match(/<source[^>]*>(.*?)<\/source>/))?.[1] || '');
      const pubDate = pubDateStr ? new Date(pubDateStr) : null;
      if (pubDate && !isNaN(pubDate.getTime())) {
        const ageDays = (now - pubDate.getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_AGE_DAYS) return null;
      }
      const dateLabel = pubDate && !isNaN(pubDate.getTime())
        ? pubDate.toLocaleDateString('es-CO', { day:'numeric', month:'long', year:'numeric' })
        : '';
      return title ? `• [${dateLabel}] ${title}${source ? ` — ${source}` : ''}` : null;
    }).filter(Boolean);

    if (googleItems.length > 0) {
      allHeadlines.push('\n--- GOOGLE NEWS (complemento) ---');
      googleItems.forEach(i => allHeadlines.push(i));
    }
  } catch (_) {}

  // ── Armar contexto final ──────────────────────────────────
  const newsCount = allHeadlines.filter(l => l.startsWith('•') || l.includes('↳')).length;
  let newsContext = '';
  if (allHeadlines.length > 0) {
    newsContext = `\n\n=== NOTICIAS REALES OBTENIDAS DE FUENTES COLOMBIANAS (Liga BetPlay 2026) ===\nFUENTES CONSULTADAS: Win Sports · FutbolRed · ESPN Colombia · Claro Sports · Google News\n${allHeadlines.join('\n')}\n=== FIN NOTICIAS ===`;
  }

  // ─────────────────────────────────────────────────────────
  // SYSTEM MESSAGE ESTRICTO
  // ─────────────────────────────────────────────────────────
  const systemMessage = newsCount > 0
    ? `Eres un periodista deportivo colombiano especializado en la Liga BetPlay 2026 (temporada actual).

REGLA ABSOLUTA - ANTI-ALUCINACION:
1. SOLO redacta contenido basado en las noticias reales de Win Sports, FutbolRed, ESPN Colombia y Claro Sports que aparecen al final.
2. PROHIBIDO inventar: resultados, marcadores, fichajes, declaraciones o estadisticas que NO aparezcan en esas noticias.
3. Si una noticia dice un marcador, transcribelo exacto. No lo cambies.
4. PROHIBIDO usar datos de temporadas anteriores (2025, 2024) como si fueran de 2026.
5. Si no hay informacion suficiente para un campo, ponlo vago o general — nunca lo inventes.
6. Devuelve UNICAMENTE el JSON solicitado, sin backticks, sin texto extra.`
    : `Eres un periodista deportivo colombiano especializado en la Liga BetPlay 2026.

ADVERTENCIA: No se encontraron noticias recientes en Win Sports, FutbolRed, ESPN Colombia ni Claro Sports.
REGLA: Genera solo contenido tipo ANALISIS o CONTEXTO GENERAL. No presentes nada como noticia del dia.
El campo "category" DEBE ser "ANALISIS". El "summary" debe aclarar que es contexto general, no noticia reciente.
PROHIBIDO usar resultados o datos de 2025/2024 como si fueran de 2026.
Devuelve UNICAMENTE el JSON solicitado, sin backticks, sin texto extra.`;

  // ─────────────────────────────────────────────────────────
  // LLAMADA A GROQ
  // ─────────────────────────────────────────────────────────
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2048,
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user',   content: prompt + newsContext },
        ],
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      return res.status(groqRes.status).json({ error: err.error?.message || `Error Groq: HTTP ${groqRes.status}` });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content || '';

    return res.status(200).json({ text, newsImageUrl, newsCount, newsFound: newsCount > 0 });

  } catch (e) {
    return res.status(500).json({ error: 'Error del servidor: ' + e.message });
  }
}
