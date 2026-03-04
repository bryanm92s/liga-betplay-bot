export default async function handler(req, res) {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, apiKey } = req.body;

  if (!prompt || !apiKey) {
    return res.status(400).json({ error: 'Faltan parámetros: prompt y apiKey son requeridos' });
  }

  if (!apiKey.startsWith('sk-ant-')) {
    return res.status(401).json({ error: 'API Key inválida. Debe empezar por sk-ant-' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.json();
      const msg = err.error?.message || `Error Anthropic: HTTP ${anthropicRes.status}`;
      return res.status(anthropicRes.status).json({ error: msg });
    }

    const data = await anthropicRes.json();
    const text = data.content?.map(b => b.text || '').join('\n') || '';

    return res.status(200).json({ text });

  } catch (e) {
    return res.status(500).json({ error: 'Error del servidor: ' + e.message });
  }
}
