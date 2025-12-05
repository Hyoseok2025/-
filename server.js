const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const FORCE_DEMO = (process.env.FORCE_DEMO === 'true' || process.env.FORCE_DEMO === '1');
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
  
  // If force-demo is enabled, or key is not set / is placeholder, return demo response
  if (FORCE_DEMO || !OPENAI_KEY || OPENAI_KEY.includes('REPLACE')) {
    return res.status(200).json({
      choices: [{
        message: {
          content: "안녕하세요! 서버가 현재 데모 모드로 동작 중입니다. 실제 OpenAI 호출을 사용하려면 `.env`에 유효한 `OPENAI_API_KEY`를 설정하거나 `FORCE_DEMO=false`로 변경하고 서버를 재시작하세요."
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

    // Forward to OpenAI with conservative token limits to avoid quota spikes
    const modelToUse = model || 'gpt-3.5-turbo';
    const requestedMax = parseInt(req.body.max_tokens || '128', 10) || 128;
    const maxTokens = Math.min(Math.max(requestedMax, 16), 256); // clamp between 16 and 256

    // Forward to OpenAI
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ 
        model: modelToUse,
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      })
    }).then(response => {
      // If OpenAI returns 429 (quota), fall back to demo response instead of propagating 429
      if (response.status === 429) {
        return response.json().then(data => {
          console.warn('OpenAI returned 429; returning demo response instead.');
          return res.status(200).json({
            choices: [{
              message: {
                content: "죄송합니다 — 현재 OpenAI 사용량이 초과되어 실시간 응답을 제공할 수 없습니다. 데모 모드 응답을 반환합니다."
              }
            }],
            // include original error for debugging if needed
            original_error: data
          });
        });
      }

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
      // On network/internal error, fall back to demo response so the UI remains usable
      res.status(200).json({
        choices: [{
          message: {
            content: "데모 응답: OpenAI API에 접속하는 동안 오류가 발생했습니다. 나중에 다시 시도해 주세요."
          }
        }],
        error: { message: 'Failed to reach OpenAI API.' }
      });
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
  if (FORCE_DEMO) {
    console.log(`⚠️  FORCE_DEMO is enabled — server will return demo responses.`);
  }
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('REPLACE')) {
    console.log(`⚠️  Warning: OPENAI_API_KEY not set. Using demo mode.`);
    console.log(`   Set OPENAI_API_KEY in .env to enable real API calls.`);
  }
});
