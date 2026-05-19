const cron = require('node-cron');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Weather cache
let weatherCache = null;
let weatherCacheTime = 0;
const CACHE_DURATION = 30 * 60 * 1000; 

// Traffic cache
let trafficCache = null;
let trafficCacheTime = 0;
const TRAFFIC_CACHE_DURATION = 15 * 60 * 1000;

// Key Abuja road corridors with TomTom coordinates
// Using only coordinates confirmed to work with TomTom's flow data API
// TomTom coverage in Abuja is limited to major expressways and arterial roads
const ABUJA_CORRIDORS = [
  { name: 'Nnamdi Azikiwe Expressway', point: '9.0579,7.4891' },      // ✅ Confirmed working
  { name: 'Airport Road', point: '9.0079,7.4310' },                    // Airport/Lugbe area
  { name: 'Kubwa Expressway', point: '9.1200,7.3500' },                // Kubwa axis
  { name: 'Abuja-Keffi Road', point: '9.0900,7.5200' },                // Keffi/Mararaba
  { name: 'Herbert Macaulay Way', point: '9.0747,7.4760' },            // Wuse Central
];

// Fallback single-corridor mode for when API limits or errors occur
// This ensures alerts.html still shows some traffic data even if multi-fetch fails
let lastWorkingSegment = null;

async function saveArticleToGitHub(article, dateStr) {
  const filename = `articles/${dateStr}.json`;
  const content = Buffer.from(JSON.stringify({
    date: dateStr,
    article: article,
    generatedAt: new Date().toISOString()
  })).toString('base64');

  let sha;
  try {
    const check = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${filename}`, {
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json'
      }
    });
    if (check.ok) {
      const existing = await check.json();
      sha = existing.sha;
    }
  } catch (_) {}

  const body = {
    message: `forecast: ${dateStr}`,
    content,
    ...(sha && { sha })
  };

  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${filename}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub save failed: ${err.message}`);
  }

  console.log(`Article saved to GitHub: ${filename}`);
}

// ── SVG 1: Abuja Geography Schematic ──────────────────────────────────────────
function buildGeographySVG(c) {
  const temp = Math.round(c.temperature_2m);
  const humidity = c.relative_humidity_2m;
  return `<div class="article-map">
<svg viewBox="0 0 520 320" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block;max-width:600px;margin:1.5rem auto;border-radius:16px;background:#0f1923;">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="#94a3b8" stroke-width="1.5"/>
    </marker>
  </defs>
  <!-- FCT boundary outline (simplified polygon) -->
  <polygon points="120,60 200,40 310,50 390,80 420,150 400,240 340,280 220,290 140,260 90,190 80,130" fill="none" stroke="#334155" stroke-width="1.5" stroke-dasharray="6 3"/>
  <!-- Districts -->
  <circle cx="230" cy="155" r="28" fill="#1e3a5f" stroke="#3b82f6" stroke-width="1"/>
  <text x="230" y="150" text-anchor="middle" fill="#93c5fd" font-size="11" font-family="Inter,sans-serif" font-weight="600">Maitama</text>
  <circle cx="290" cy="190" r="22" fill="#1a3a2a" stroke="#22c55e" stroke-width="1"/>
  <text x="290" y="194" text-anchor="middle" fill="#86efac" font-size="10" font-family="Inter,sans-serif">Garki</text>
  <circle cx="175" cy="185" r="20" fill="#2a1f3a" stroke="#a855f7" stroke-width="1"/>
  <text x="175" y="189" text-anchor="middle" fill="#d8b4fe" font-size="10" font-family="Inter,sans-serif">Wuse</text>
  <circle cx="260" cy="115" r="18" fill="#1a2a3a" stroke="#38bdf8" stroke-width="1"/>
  <text x="260" y="119" text-anchor="middle" fill="#7dd3fc" font-size="10" font-family="Inter,sans-serif">Gwarinpa</text>
  <!-- Aso Rock marker -->
  <polygon points="320,155 330,135 340,155" fill="#475569" stroke="#94a3b8" stroke-width="1"/>
  <text x="342" y="148" fill="#94a3b8" font-size="9" font-family="Inter,sans-serif">Aso Rock</text>
  <!-- City center dot -->
  <circle cx="255" cy="160" r="5" fill="#f59e0b"/>
  <circle cx="255" cy="160" r="9" fill="none" stroke="#f59e0b" stroke-width="1" opacity="0.5"/>
  <!-- Conditions badge -->
  <rect x="20" y="20" width="120" height="52" rx="8" fill="#1e293b" stroke="#334155" stroke-width="0.5"/>
  <text x="80" y="38" text-anchor="middle" fill="#f1f5f9" font-size="11" font-family="Inter,sans-serif" font-weight="600">Abuja</text>
  <text x="80" y="54" text-anchor="middle" fill="#f59e0b" font-size="16" font-family="Inter,sans-serif" font-weight="700">${temp}°C</text>
  <text x="80" y="66" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="Inter,sans-serif">Humidity ${humidity}%</text>
  <!-- Label -->
  <text x="260" y="308" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif">FCT — Federal Capital Territory</text>
</svg></div>`;
}

// ── SVG 2: Wind Rose ──────────────────────────────────────────────────────────
function buildWindSVG(c) {
  const speed = Math.round(c.wind_speed_10m);
  const dir = c.wind_direction_10m || 0;
  const rad = (dir - 90) * Math.PI / 180;
  const cx = 200, cy = 150, r = 80;
  const ax = cx + r * Math.cos(rad);
  const ay = cy + r * Math.sin(rad);
  const description = dir >= 337.5 || dir < 22.5 ? 'Northerly' :
    dir < 67.5 ? 'NE' : dir < 112.5 ? 'Easterly' : dir < 157.5 ? 'SE' :
    dir < 202.5 ? 'Southerly' : dir < 247.5 ? 'SW' : dir < 292.5 ? 'Westerly' : 'NW';
  return `<div class="article-map">
<svg viewBox="0 0 400 300" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block;max-width:600px;margin:1.5rem auto;border-radius:16px;background:#0f1923;">
  <!-- Compass rings -->
  <circle cx="${cx}" cy="${cy}" r="100" fill="none" stroke="#1e293b" stroke-width="1"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1e293b" stroke-width="0.5" stroke-dasharray="4 4"/>
  <circle cx="${cx}" cy="${cy}" r="40" fill="none" stroke="#1e293b" stroke-width="0.5"/>
  <!-- Cardinal tick marks -->
  <line x1="${cx}" y1="${cy-100}" x2="${cx}" y2="${cy-88}" stroke="#334155" stroke-width="1.5"/>
  <line x1="${cx}" y1="${cy+88}" x2="${cx}" y2="${cy+100}" stroke="#334155" stroke-width="1.5"/>
  <line x1="${cx-100}" y1="${cy}" x2="${cx-88}" y2="${cy}" stroke="#334155" stroke-width="1.5"/>
  <line x1="${cx+88}" y1="${cy}" x2="${cx+100}" y2="${cy}" stroke="#334155" stroke-width="1.5"/>
  <!-- Cardinal labels -->
  <text x="${cx}" y="${cy-108}" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Inter,sans-serif" font-weight="600">N</text>
  <text x="${cx}" y="${cy+118}" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Inter,sans-serif" font-weight="600">S</text>
  <text x="${cx-112}" y="${cy+4}" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Inter,sans-serif" font-weight="600">W</text>
  <text x="${cx+112}" y="${cy+4}" text-anchor="middle" fill="#94a3b8" font-size="12" font-family="Inter,sans-serif" font-weight="600">E</text>
  <!-- Wind arrow -->
  <line x1="${cx}" y1="${cy}" x2="${ax}" y2="${ay}" stroke="#38bdf8" stroke-width="3" stroke-linecap="round" marker-end="url(#arr)"/>
  <circle cx="${cx}" cy="${cy}" r="5" fill="#38bdf8"/>
  <!-- Info panel -->
  <rect x="260" y="60" width="120" height="80" rx="8" fill="#1e293b" stroke="#334155" stroke-width="0.5"/>
  <text x="320" y="82" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">Wind speed</text>
  <text x="320" y="104" text-anchor="middle" fill="#38bdf8" font-size="22" font-family="Inter,sans-serif" font-weight="700">${speed}</text>
  <text x="320" y="120" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Inter,sans-serif">km/h · ${description}</text>
  <!-- Label -->
  <text x="200" y="285" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif">Wind direction and speed — Abuja</text>
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
    </marker>
  </defs>
</svg></div>`;
}

// ── SVG 3: Rain Probability Timeline ─────────────────────────────────────────
function buildRainfallSVG(d) {
  const days = d.time.slice(0, 7);
  const probs = d.precipitation_probability_max.slice(0, 7);
  const barW = 44, gap = 20, startX = 60, baseY = 220;
  const bars = days.map((date, i) => {
    const prob = probs[i];
    const barH = Math.max(4, (prob / 100) * 160);
    const x = startX + i * (barW + gap);
    const y = baseY - barH;
    const label = new Date(date + 'T12:00:00').toLocaleDateString('en-NG', { weekday: 'short' });
    const color = prob >= 70 ? '#3b82f6' : prob >= 40 ? '#38bdf8' : '#1e3a5f';
    const textColor = prob >= 70 ? '#93c5fd' : prob >= 40 ? '#7dd3fc' : '#475569';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="4" fill="${color}"/>
<text x="${x + barW/2}" y="${y - 6}" text-anchor="middle" fill="${textColor}" font-size="10" font-family="Inter,sans-serif">${prob}%</text>
<text x="${x + barW/2}" y="${baseY + 16}" text-anchor="middle" fill="#64748b" font-size="10" font-family="Inter,sans-serif">${label}</text>`;
  }).join('\n');
  return `<div class="article-map">
<svg viewBox="0 0 520 280" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block;max-width:600px;margin:1.5rem auto;border-radius:16px;background:#0f1923;">
  <!-- Grid lines -->
  <line x1="50" y1="60" x2="490" y2="60" stroke="#1e293b" stroke-width="0.5"/>
  <line x1="50" y1="100" x2="490" y2="100" stroke="#1e293b" stroke-width="0.5"/>
  <line x1="50" y1="140" x2="490" y2="140" stroke="#1e293b" stroke-width="0.5"/>
  <line x1="50" y1="180" x2="490" y2="180" stroke="#1e293b" stroke-width="0.5"/>
  <line x1="50" y1="220" x2="490" y2="220" stroke="#334155" stroke-width="1"/>
  <!-- Y axis labels -->
  <text x="44" y="64" text-anchor="end" fill="#475569" font-size="9" font-family="Inter,sans-serif">100%</text>
  <text x="44" y="104" text-anchor="end" fill="#475569" font-size="9" font-family="Inter,sans-serif">75%</text>
  <text x="44" y="144" text-anchor="end" fill="#475569" font-size="9" font-family="Inter,sans-serif">50%</text>
  <text x="44" y="184" text-anchor="end" fill="#475569" font-size="9" font-family="Inter,sans-serif">25%</text>
  <text x="44" y="224" text-anchor="end" fill="#475569" font-size="9" font-family="Inter,sans-serif">0%</text>
  ${bars}
  <text x="270" y="265" text-anchor="middle" fill="#475569" font-size="10" font-family="Inter,sans-serif">Rain probability — 7-day outlook</text>
</svg></div>`;
}

async function generateAndSave() {
  console.log('Running daily forecast generation...');
  try {
    // 1. FETCH WEATHER DATA
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=9.0765&longitude=7.3986` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
      `wind_speed_10m,wind_direction_10m,surface_pressure,uv_index` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
      `&timezone=Africa%2FLagos&forecast_days=7`
    );
    const weatherData = await weatherRes.json();
    if (!weatherData.current) throw new Error('Open-Meteo returned no current data.');
    const c = weatherData.current;
    const d = weatherData.daily;
    console.log('Weather data fetched successfully');

    // 2. FETCH TRAFFIC DATA
    let trafficSummary = '';
    try {
      const trafficRes = await fetch(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=9.0579,7.4891&key=${process.env.TOMTOM_TRAFFIC_API}`);
      if (trafficRes.ok) {
        const trafficData = await trafficRes.json();
        const fd = trafficData.flowSegmentData;
        const congestion = fd.freeFlowSpeed > 0 ? Math.max(0, 1 - (fd.currentSpeed / fd.freeFlowSpeed)) : 0;
        const level = congestion >= 0.7 ? 'heavy' : congestion >= 0.4 ? 'moderate' : 'light';
        trafficSummary = `Nnamdi Azikiwe Expressway traffic is currently ${level} (${Math.round(fd.currentSpeed)} km/h vs free-flow ${Math.round(fd.freeFlowSpeed)} km/h).`;
      }
    } catch (_) { trafficSummary = ''; }

    // 3. BUILD FORECAST LINES
    const fullForecastLines = d.time.map((date, i) =>
      `${date}: High ${Math.round(d.temperature_2m_max[i])}°C / Low ${Math.round(d.temperature_2m_min[i])}°C, ${d.precipitation_probability_max[i]}% rain chance`
    ).join('\n');

    // 4. CONSTRUCT PROMPT
    const prompt = `You are the voice of a trusted local weather blog covering Abuja, Nigeria. Write a daily forecast post in the style of Space City Weather: conversational, honest, hype-free, expert but never condescending.

CURRENT CONDITIONS:
- Temperature: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C)
- Humidity: ${c.relative_humidity_2m}%
- Wind: ${Math.round(c.wind_speed_10m)} km/h
- UV Index: ${Math.round(c.uv_index || 0)}
${trafficSummary ? `- Traffic: ${trafficSummary}` : ''}

7-DAY FORECAST DATA (use this for context only):
${fullForecastLines}

Write a natural, flowing forecast. Use ### headers for each day (Monday, Tuesday, Wednesday, Thursday, Friday). Do not include Saturday or Sunday. Do not include any image placeholders or markers of any kind.

Write 8-12 paragraphs, minimum 600 words. Start with "In brief:" summary. Reference Abuja landmarks naturally.${trafficSummary ? ' Mention road conditions naturally if weather may affect travel.' : ''}`;

    // 5. CALL GROQ WITH WEATHER DATA
    const groqRes = await fetch('http://localhost:3000/api/forecast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: prompt,
        weatherData: {
          current: c,
          daily: d
        }
      })
    });
    const groqData = await groqRes.json();
    let article = groqData.text;
    console.log('Article generated and processed successfully');

    // 6. SAVE TO GITHUB
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    await saveArticleToGitHub(article, dateStr);
    console.log('GitHub save completed');

  } catch (err) {
    console.error('Generation failed:', err.message);
  }
}

// Updated /api/forecast endpoint with post-processing and SVG injection
app.post('/api/forecast', async (req, res) => {
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: req.body.prompt }],
        max_tokens: 2000,
        stream: false
      })
    });
    const data = await response.json();
    let article = data.choices[0].message.content?.trim() || '';

    // Strip map markers and 📡 lines
    article = article.replace(/\[MAP:[^\]]*\]/gi, '');
    article = article.replace(/📡[^\n]*/g, '');


    // Strip paragraphs that only discuss weekends
    article = article.replace(/^(?!.*\b(Monday|Tuesday|Wednesday|Thursday|Friday)\b).*\b(Saturday|Sunday)\b.*$/gm, '');

    // Collapse excess blank lines
    article = article.replace(/\n{3,}/g, '\n\n').trim();

    // Inject SVGs at fixed positions using weather data from the request
    const weatherData = req.body.weatherData;
    if (weatherData) {
      const c = weatherData.current;
      const d = weatherData.daily;
      const paragraphs = article.split(/\n\n+/).filter(p => p.trim());
      const withMaps = [];
      paragraphs.forEach((p, i) => {
        withMaps.push(p);
        if (i === 1) withMaps.push(buildGeographySVG(c));
        if (i === 4) withMaps.push(buildWindSVG(c));
        if (i === 7) withMaps.push(buildRainfallSVG(d));
      });
      article = withMaps.join('\n\n');
    }

    res.json({ text: article });
  } catch (err) {
    console.error('Error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Traffic endpoint with fallback and resilience
app.get('/api/traffic', async (req, res) => {
  try {
    const now = Date.now();
    if (trafficCache && (now - trafficCacheTime) < TRAFFIC_CACHE_DURATION) {
      return res.json(trafficCache);
    }

    const apiKey = process.env.TOMTOM_TRAFFIC_API;
    if (!apiKey) {
      return res.status(500).json({ error: 'TomTom API key not configured' });
    }

    // Fetch flow data for each corridor in parallel
    const results = await Promise.all(
      ABUJA_CORRIDORS.map(async (corridor) => {
        try {
          const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${corridor.point}&key=${apiKey}`;
          const r = await fetch(url);
          if (!r.ok) {
            console.warn(`TomTom error ${r.status} for ${corridor.name}`);
            return null;
          }
          const data = await r.json();
          
          // Check if we got valid flow data
          if (!data.flowSegmentData) {
            console.warn(`No flowSegmentData for ${corridor.name}`);
            return null;
          }
          
          const fd = data.flowSegmentData;
          const currentSpeed = fd.currentSpeed;
          const freeFlowSpeed = fd.freeFlowSpeed;
          
          if (!currentSpeed || !freeFlowSpeed) {
            console.warn(`Missing speed data for ${corridor.name}`);
            return null;
          }
          
          const congestion = freeFlowSpeed > 0 ? Math.max(0, 1 - (currentSpeed / freeFlowSpeed)) : 0;

          // Store the first working segment as fallback
          if (!lastWorkingSegment && currentSpeed) {
            lastWorkingSegment = {
              name: corridor.name,
              currentSpeed,
              freeFlowSpeed,
              congestion: Math.round(congestion * 100) / 100
            };
          }

          return {
            name: corridor.name,
            currentSpeed,
            freeFlowSpeed,
            congestion: Math.round(congestion * 100) / 100
          };
        } catch (err) {
          console.warn(`Traffic fetch failed for ${corridor.name}:`, err.message);
          return null;
        }
      })
    );

    let filtered = results.filter(Boolean);
    
    // If no segments returned but we have a working fallback, use it
    if (filtered.length === 0 && lastWorkingSegment) {
      console.log('Using last working segment as fallback');
      filtered = [lastWorkingSegment];
    }
    
    trafficCache = filtered;
    trafficCacheTime = now;

    res.json(filtered);
  } catch (err) {
    console.error('Traffic endpoint error:', err.message);
    // Return last working segment if available instead of failing completely
    if (lastWorkingSegment) {
      return res.json([lastWorkingSegment]);
    }
    res.status(500).json({ error: 'Traffic fetch failed', detail: err.message });
  }
});

// Manual trigger endpoint — for testing and cron-job.org
app.get('/api/generate', async (req, res) => {
  await generateAndSave();
  res.json({ ok: true });
});

// /api/weather endpoint with 30-minute cache and error guard
app.get('/api/weather', async (req, res) => {
  try {
    const now = Date.now();
    if (weatherCache && (now - weatherCacheTime) < CACHE_DURATION) {
      return res.json(weatherCache);
    }

    const LAT = 9.0765, LON = 7.3986;

    const today = new Date();
    const past = new Date(today);
    past.setDate(today.getDate() - 7);
    const fmt = d => d.toISOString().split('T')[0];

    const [forecast, historical] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
        `wind_speed_10m,wind_direction_10m,surface_pressure,uv_index` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,` +
        `precipitation_probability_max,precipitation_sum` +
        `&timezone=Africa%2FLagos&forecast_days=7&wind_speed_unit=kmh`
      ).then(r => r.json()),
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
        `&timezone=Africa%2FLagos&start_date=${fmt(past)}&end_date=${fmt(today)}`
      ).then(r => r.json())
    ]);

    // Guard: Check for errors before caching
    if (forecast.error || historical.error) {
      console.error('Weather API returned error:', { forecastError: forecast.error, historicalError: historical.error });
      return res.status(503).json({ error: 'Weather data temporarily unavailable' });
    }

    weatherCache = { forecast, historical };
    weatherCacheTime = now;

    res.json(weatherCache);
  } catch (err) {
    console.error('Weather endpoint error:', err.message);
    res.status(500).json({ error: 'Failed to fetch weather data', detail: err.message });
  }
});

app.use(express.static('.'));

// Scheduled cron job — 6am WAT daily
cron.schedule('0 6 * * *', generateAndSave, { timezone: 'Africa/Lagos' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));