const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static site (index.html and assets)
app.use(express.static(path.join(__dirname)));

// Proxy endpoint to call OpenAI Chat Completions securely
app.post('/api/chat', async (req, res) => {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return res.status(500).json({ error: { message: 'Server missing OPENAI_API_KEY in environment.' } });
  }

  try {
    const { model, messages } = req.body;
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ model: model || 'gpt-3.5-turbo', messages })
    });

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Error forwarding to OpenAI:', err);
    return res.status(500).json({ error: { message: err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
