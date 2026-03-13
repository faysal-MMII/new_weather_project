const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/forecast', async (req, res) => {
  try {
    const response = await fetch('https://api.ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OLLAMA_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        messages: [{ role: 'user', content: req.body.prompt }],
        stream: false
      })
    });

    const data = await response.json();
    res.json({ text: data.message?.content?.trim() || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
