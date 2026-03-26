const cron = require('node-cron');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

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

cron.schedule('0 6 * * *', async () => {
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
    console.log('Weather data fetched successfully');
    // TODO: generate article and post to WordPress once WP is public
  } catch (err) {
    console.error('Cron job failed:', err.message);
  }
}, { timezone: 'Africa/Lagos' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));