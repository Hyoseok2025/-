const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const FORCE_DEMO = (process.env.FORCE_DEMO === 'true' || process.env.FORCE_DEMO === '1');

// Mask a secret for safe logging (do not print full key)
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0,4)}...${k.slice(-4)}`;
}

const STARTUP_KEY_SOURCE = (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('REPLACE'))
  ? 'OPENAI_API_KEY'
  : (process.env.MY_API_KEY ? 'MY_API_KEY' : 'none');

const STARTUP_KEY_PREVIEW = STARTUP_KEY_SOURCE === 'OPENAI_API_KEY'
  ? maskKey(process.env.OPENAI_API_KEY)
  : (STARTUP_KEY_SOURCE === 'MY_API_KEY' ? maskKey(process.env.MY_API_KEY) : null);
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

// ========== Diagnostics & Canned Responses ==========
let lastOpenAIStatus = { status: null, timestamp: null, body: null };

// Simple in-memory cache for canned responses per character (could be expanded)
const cannedResponses = {
  horn: "하하하! 전장 경험으로 말하자면, 네가 다음 수를 내기 전에 내게 묻거라. 강하게, 그러나 신중하게.",
  hwarin: "검은 마음을 다스리고 몸을 바로잡아라. 자세가 흔들리면 기술도 흔들린다.",
  kai: "어이 챔피언, 부품은 여기서 구해. 싸게 해줄게. 다음엔 더 강한 삽질로 돌려줄게~"
};

// small LRU-like cache for demo responses (keyed by character)
const demoCache = new Map();
function cacheDemoResponse(characterKey, response) {
  demoCache.set(characterKey, { response, ts: Date.now() });
  // keep cache small
  if (demoCache.size > 10) {
    const firstKey = demoCache.keys().next().value;
    demoCache.delete(firstKey);
  }
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
// (SPA fallback moved below after API routes)

// ========== API: Chat Completions Proxy ==========
app.post('/api/chat', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  
  // Rate limiting
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ 
      error: { message: 'Too many requests. Please try again later.' } 
    });
  }

  // Support either OPENAI_API_KEY (preferred) or MY_API_KEY (alternate)
  const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.MY_API_KEY;
  
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
      // update lastOpenAIStatus
      return response.text().then(bodyText => {
        let parsed = null;
        try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch (e) { parsed = { raw: bodyText }; }
        lastOpenAIStatus = { status: response.status, timestamp: new Date().toISOString(), body: (parsed && parsed.error && parsed.error.message) ? parsed.error.message : (typeof bodyText === 'string' ? bodyText.slice(0, 500) : null) };

        // If OpenAI returns 429 (quota), fall back to canned/demo response instead of propagating 429
        if (response.status === 429) {
          console.warn('OpenAI returned 429; returning canned/demo response instead.');
          const charKey = req.body.character;
          const canned = (charKey && cannedResponses[charKey]) ? cannedResponses[charKey] : "죄송합니다 — 현재 OpenAI 사용량이 초과되어 실시간 응답을 제공할 수 없습니다. 잠시 후 다시 시도해 주세요.";
          cacheDemoResponse(charKey || 'generic', canned);
          return res.status(200).json({ choices: [{ message: { content: canned } }], original_error: parsed });
        }

        if (!response.ok) {
          // propagate other errors
          return res.status(response.status).json(parsed || { error: { message: 'Unknown error from OpenAI' } });
        }

        // success path: return parsed JSON
        return res.json(parsed);
      });
    }).catch(err => {
      console.error('Error forwarding to OpenAI:', err);
      lastOpenAIStatus = { status: 'network_error', timestamp: new Date().toISOString(), body: err.message };
      // On network/internal error, attempt to return character-specific canned response
      const charKey = req.body.character;
      const cached = demoCache.get(charKey);
      if (cached) {
        return res.status(200).json({ choices: [{ message: { content: cached.response } }], note: 'served from demo cache' });
      }
      const canned = (charKey && cannedResponses[charKey]) ? cannedResponses[charKey] : "데모 응답: OpenAI API에 접속하는 동안 오류가 발생했습니다. 나중에 다시 시도해 주세요.";
      cacheDemoResponse(charKey || 'generic', canned);
      return res.status(200).json({ choices: [{ message: { content: canned } }], error: { message: 'Failed to reach OpenAI API.' } });
    });

  } catch (err) {
    console.error('Error processing request:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ========== Health Check ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), lastOpenAIStatus });
});

// Diagnostics endpoint: show last OpenAI status, FORCE_DEMO, key source and basic rate info
app.get('/api/diagnostics', (req, res) => {
  const rateInfo = {
    trackedClients: requestCounts.size,
    windowMs: RATE_LIMIT_WINDOW,
    maxRequestsPerMinute: MAX_REQUESTS_PER_MINUTE
  };
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    lastOpenAIStatus,
    FORCE_DEMO,
    key_source: STARTUP_KEY_SOURCE,
    key_preview: STARTUP_KEY_PREVIEW,
    rateInfo
  });
});

// Fallback to index.html for SPA routing (non-API routes)
app.get(/^(?!\/api)(?!.*\.(js|css|json|jpg|png|gif|svg|ico|woff|woff2)$).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== Start Server ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log(`📝 API Endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`💊 Health Check: GET http://localhost:${PORT}/api/health`);
  if (FORCE_DEMO) {
    console.log(`⚠️  FORCE_DEMO is enabled — server will return demo responses.`);
  }

  // Log which environment variable will be used for the API key (masked)
  if (STARTUP_KEY_SOURCE === 'OPENAI_API_KEY') {
    console.log(`🔑 Using API key from OPENAI_API_KEY (masked): ${STARTUP_KEY_PREVIEW}`);
  } else if (STARTUP_KEY_SOURCE === 'MY_API_KEY') {
    console.log(`🔑 Using API key from MY_API_KEY (masked): ${STARTUP_KEY_PREVIEW}`);
    console.log('   Tip: You can rename to OPENAI_API_KEY to prefer that variable.');
  } else {
    console.log(`⚠️  No API key found in environment. Server will return demo responses.`);
    console.log(`   Set OPENAI_API_KEY or MY_API_KEY in .env to enable real API calls.`);
  }
});
