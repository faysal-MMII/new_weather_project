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

async function generateAndSave() {
  console.log('Running daily forecast generation...');
  try {
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=9.0765&longitude=7.3986` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
      `wind_speed_10m,wind_direction_10m,surface_pressure,uv_index` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
      `&timezone=Africa%2FLagos&forecast_days=7`
    );
    const weatherData = await weatherRes.json();
    
    console.log('Open-Meteo response:', JSON.stringify(weatherData));
    
    if (!weatherData.current) {
      throw new Error('Open-Meteo returned no current data. Response: ' + JSON.stringify(weatherData));
    }
    
    const c = weatherData.current;
    const d = weatherData.daily;
    console.log('Weather data fetched successfully');

    let trafficSummary = '';
    try {
      // Use the confirmed working coordinate for traffic summary
      const trafficRes = await fetch(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=9.0579,7.4891&key=${process.env.TOMTOM_TRAFFIC_API}`);
      if (trafficRes.ok) {
        const trafficData = await trafficRes.json();
        const fd = trafficData.flowSegmentData;
        const congestion = fd.freeFlowSpeed > 0 ? Math.max(0, 1 - (fd.currentSpeed / fd.freeFlowSpeed)) : 0;
        const level = congestion >= 0.7 ? 'heavy' : congestion >= 0.4 ? 'moderate' : 'light';
        trafficSummary = `Nnamdi Azikiwe Expressway traffic is currently ${level} (${Math.round(fd.currentSpeed)} km/h vs free-flow ${Math.round(fd.freeFlowSpeed)} km/h).`;
      }
    } catch (_) {
      trafficSummary = '';
    }

    // Build full 7-day forecast data for context (AI needs weekend data for pattern description)
    const fullForecastLines = d.time.map((date, i) =>
      `${date}: High ${Math.round(d.temperature_2m_max[i])}°C / Low ${Math.round(d.temperature_2m_min[i])}°C, ${d.precipitation_probability_max[i]}% rain chance`
    ).join('\n');

    const prompt = `You are the voice of a trusted local weather blog covering Abuja, Nigeria. Write a daily forecast post in the style of Space City Weather: conversational, honest, hype-free, expert but never condescending.

CURRENT CONDITIONS:
- Temperature: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C)
- Humidity: ${c.relative_humidity_2m}%
- Wind: ${Math.round(c.wind_speed_10m)} km/h
- UV Index: ${Math.round(c.uv_index || 0)}
${trafficSummary ? `- Traffic: ${trafficSummary}` : ''}

7-DAY FORECAST DATA (use this for context only):
${fullForecastLines}

Do not write a day-by-day breakdown. Instead, describe the general weather pattern for the coming days in prose. Only reference specific days if something notable is happening — a significant rain event, a heat spike, etc. Never mention Saturday or Sunday by name. The forecast horizon is the current week only.

Write 8-12 paragraphs, minimum 600 words. Start with "In brief:" summary. Use ### for day headers.

Include exactly three image placeholders, each on its own line with a blank line before and after it, placed naturally between sections:
[MAP: geography] — after the opening section
[MAP: wind] — when discussing wind or atmospheric movement
[MAP: rainfall] — when discussing rain chances or weekly outlook

Each marker must stand alone as its own paragraph. Do not write sentences that lead into or out of the marker. The paragraph before it should end cleanly. The paragraph after it should start fresh.

Do not add any other [MAP:] markers. Do not place them at the very start or very end of the article.

No bullet points. Reference Abuja landmarks naturally.${trafficSummary ? ' Mention road conditions naturally if weather may affect travel.' : ''}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        stream: false
      })
    });
    const groqData = await groqRes.json();
    const article = groqData.choices[0].message.content.trim();
    console.log('Article generated successfully');

    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    console.log('Attempting GitHub save for date:', dateStr);
    console.log('GITHUB_REPO:', process.env.GITHUB_REPO);
    console.log('GITHUB_TOKEN set:', !!process.env.GITHUB_TOKEN);
    await saveArticleToGitHub(article, dateStr);
    console.log('GitHub save completed');

  } catch (err) {
    console.error('Generation failed:', err.message);
  }
}

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
    console.log('Groq response:', JSON.stringify(data));
    res.json({ text: data.choices[0].message.content?.trim() || '' });
  } catch (err) {
    console.error('Error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
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