const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/forecast', async (req, res) => {
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: req.body.prompt }],
        stream: false
      })
    });

    const data = await response.json();
    res.json({ text: data.choices[0].message.content?.trim() || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static('.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));