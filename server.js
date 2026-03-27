const cron = require('node-cron');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

async function saveArticleToGitHub(article, dateStr) {
  const filename = `articles/${dateStr}.json`;
  const content = Buffer.from(JSON.stringify({
    date: dateStr,
    article: article,
    generatedAt: new Date().toISOString()
  })).toString('base64');

  // Check if file already exists (needed for SHA if updating)
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
    // Step 1: Fetch weather data
    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=9.0765&longitude=7.3986` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
      `wind_speed_10m,wind_direction_10m,surface_pressure,uv_index` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum` +
      `&timezone=Africa%2FLagos&forecast_days=7`
    );
    const weatherData = await weatherRes.json();
    const c = weatherData.current;
    const d = weatherData.daily;
    console.log('Weather data fetched successfully');

    // Step 2: Build prompt
    const prompt = `You are the voice of a trusted local weather blog covering Abuja, Nigeria. Write a daily forecast post in the style of Space City Weather: conversational, honest, hype-free, expert but never condescending.

CURRENT CONDITIONS:
- Temperature: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C)
- Humidity: ${c.relative_humidity_2m}%
- Wind: ${Math.round(c.wind_speed_10m)} km/h
- UV Index: ${Math.round(c.uv_index || 0)}

7-DAY FORECAST:
${d.time.map((date, i) => `${date}: High ${Math.round(d.temperature_2m_max[i])}°C / Low ${Math.round(d.temperature_2m_min[i])}°C, ${d.precipitation_probability_max[i]}% rain chance`).join('\n')}

Write 8-12 paragraphs, minimum 600 words. Start with "In brief:" summary. Use ### for day headers. Use [MAP: description] for image placeholders. No bullet points. Reference Abuja landmarks naturally.`;

    // Step 3: Call Groq
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

    // Step 4: Save to GitHub
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    await saveArticleToGitHub(article, dateStr);

  } catch (err) {
    console.error('Generation failed:', err.message);
  }
}

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

app.use(express.static('.'));

// Scheduled cron job — 6am WAT daily
cron.schedule('0 6 * * *', generateAndSave, { timezone: 'Africa/Lagos' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));