const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ========== Rate Limiting & Security ==========
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 30;

function isRateLimited(ip) {
  const now = Date.now();
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }
  
  const times = requestCounts.get(ip);
  const recentRequests = times.filter(t => now - t < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    return true;
  }
  
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  return false;
}

// ========== Middleware ==========
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve static site (index.html and assets)
app.use(express.static(path.join(__dirname), { 
  index: 'index.html',
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.html')) {
      res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Fallback to index.html for SPA routing
app.get(/^(?!.*\.(js|css|json|jpg|png|gif|svg|ico|woff|woff2)$).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== API: Chat Completions Proxy ==========
app.post('/api/chat', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  
  // Rate limiting
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ 
      error: { message: 'Too many requests. Please try again later.' } 
    });
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  
  // If key is not set or is placeholder, return demo response
  if (!OPENAI_KEY || OPENAI_KEY.includes('REPLACE')) {
    return res.status(200).json({
      choices: [{
        message: {
          content: "안녕하세요! 저는 서버에 OPENAI_API_KEY가 설정되지 않아 실제 API를 호출할 수 없습니다. .env 파일에 유효한 OpenAI API 키를 설정해 주세요. 그 후 서버를 다시 시작하면 실제 대화가 가능합니다."
        }
      }]
    });
  }

  try {
    const { model, messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        error: { message: 'Invalid request: missing or invalid messages array.' } 
      });
    }

    // Forward to OpenAI
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ 
        model: model || 'gpt-3.5-turbo', 
        messages,
        max_tokens: 500
      })
    }).then(response => {
      if (!response.ok) {
        return response.json().then(data => {
          res.status(response.status).json(data);
        });
      }
      return response.json().then(data => {
        res.json(data);
      });
    }).catch(err => {
      console.error('Error forwarding to OpenAI:', err);
      res.status(500).json({ error: { message: 'Failed to reach OpenAI API.' } });
    });

  } catch (err) {
    console.error('Error processing request:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ========== Health Check ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== Start Server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`📝 API Endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`💊 Health Check: GET http://localhost:${PORT}/api/health`);
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('REPLACE')) {
    console.log(`⚠️  Warning: OPENAI_API_KEY not set. Using demo mode.`);
    console.log(`   Set OPENAI_API_KEY in .env to enable real API calls.`);
  }
});
