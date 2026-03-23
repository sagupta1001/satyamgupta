// ============================================================
// Satyam Gupta — Digital Self · Cloudflare Worker v3
// Routes: /chat  — career Q&A
//         /task  — build & deploy OR answer gracefully
//
// Secrets (Workers > Settings > Variables, encrypted):
//   ANTHROPIC_API_KEY
//   VERCEL_TOKEN
// ============================================================

const RATE_LIMIT = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CHAT_SYSTEM = `You are the digital version of Satyam Gupta — a software engineer based in Toronto, Canada. You speak in first person as Satyam. You are soft-spoken, confident, and thoughtful. You don't oversell yourself but you're clear and direct about your experience and capabilities.

CURRENT ROLE: Lead Software Developer at OSF Management, Toronto (Sept 2023 – Present)
- Leading resilient data ingestion pipelines, API services, and exchange integrations for a crypto/investment platform
- Co-developed an automated Rollover Bot that handles multi-million dollar positions across multiple exchanges
- Built solutions for ledger matching, loan reconciliation, exposure discrepancy detection, and MFA
- Led adoption of Copilot/Cursor AI tools and Vitest for testing

PREVIOUS: Senior Software Developer at Prodigy Education (2019–2023), Java Cloud Developer at Scotiabank (2018–2019), SDE at Amazon (2015–2018)

EDUCATION: BASc, University of Waterloo, Honours Computer Engineering, 2010–2015
CERTIFICATIONS: AWS Solutions Architect, AWS Certified Developer Associate, TypeScript for Professionals
SKILLS: Java, AWS, React, TypeScript, Python, R, Git, React Native, Ruby on Rails, Kafka, DynamoDB, Azure

PERSONALITY: Soft-spoken and confident. Clear and direct. Thoughtful. Only discusses professional career topics.`;

const TASK_SYSTEM = `You are the digital agent of Satyam Gupta, a senior software engineer. You help with two things:

1. BUILDING sites — when asked to build, create, make, or design something, respond with this exact JSON (raw JSON only, no markdown, no backticks):
{
  "type": "build",
  "plan": "2-3 sentence description of your approach",
  "filename": "index.html",
  "html": "the complete, self-contained HTML file as a string"
}

2. EVERYTHING ELSE — questions, reviews, opinions, anything that is not a build request, respond with this exact JSON (raw JSON only, no markdown, no backticks):
{
  "type": "message",
  "reply": "your helpful, thoughtful response here"
}

For HTML you build:
- Single self-contained file (inline CSS and JS, Google Fonts and cdnjs allowed)
- Visually stunning and production-grade
- Strong aesthetic point of view — dark or light theme
- Distinctive typography, smooth animations, mobile responsive
- Reflect Satyam's style: clean, confident, no fluff
- Always include a subtle "Built by Digital Satyam" credit in the footer

CRITICAL: Always respond with valid raw JSON. Never include markdown fences or any text outside the JSON object.`;

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.RATE) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `${ip}:${today}`;
      const count = parseInt(await env.RATE.get(key) || '0');
      if (count >= RATE_LIMIT) {
        return json({ error: 'Daily limit reached. Come back tomorrow.' }, 429);
      }
      await env.RATE.put(key, String(count + 1), { expirationTtl: 86400 });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400); }

    // ── /chat ──────────────────────────────────────────────
    if (path === '/chat') {
      const { messages } = body;
      if (!messages) return json({ error: 'messages required' }, 400);
      const data = await callClaude(env.ANTHROPIC_API_KEY, CHAT_SYSTEM, messages, 1000);
      if (data.error) return json({ error: data.error.message }, 500);
      return json({ reply: data.content[0].text });
    }

    // ── /task ──────────────────────────────────────────────
    if (path === '/task') {
      const { task } = body;
      if (!task) return json({ error: 'task required' }, 400);

      const data = await callClaude(env.ANTHROPIC_API_KEY, TASK_SYSTEM, [
        { role: 'user', content: task }
      ], 4000);

      if (data.error) return json({ error: data.error.message }, 500);

      let parsed;
      try {
        const raw = data.content[0].text
          .replace(/^```json\s*/i, '')
          .replace(/^```\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'Agent returned an unexpected response. Please try again.' }, 500);
      }

      // Non-build response — just return the message
      if (parsed.type === 'message') {
        return json({ reply: parsed.reply });
      }

      // Build response — deploy to Vercel
      if (parsed.type === 'build') {
        const deployResult = await deployToVercel(env.VERCEL_TOKEN, parsed.html, parsed.filename || 'index.html');
        if (deployResult.error) return json({ error: deployResult.error }, 500);
        return json({
          plan: parsed.plan,
          url: deployResult.url,
        });
      }

      return json({ error: 'Unknown agent response type.' }, 500);
    }

    return json({ error: 'Unknown route' }, 404);
  }
};

// ── Helpers ────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

async function callClaude(apiKey, system, messages, maxTokens = 1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  return res.json();
}

async function deployToVercel(token, html, filename = 'index.html') {
  try {
    const projectName = `satyam-agent-${Date.now()}`;

    const res = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        target: 'production',
        files: [{ file: filename, data: html, encoding: 'utf8' }],
        projectSettings: {
          framework: null,
          buildCommand: null,
          outputDirectory: null,
          installCommand: null,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error?.message || 'Vercel deployment failed' };

    const deploymentId = data.id;
    let deployUrl = data.url;

    // Poll until ready (max 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const status = await check.json();
      if (status.readyState === 'READY') { deployUrl = status.url; break; }
      if (status.readyState === 'ERROR') return { error: 'Deployment failed on Vercel' };
    }

    return { url: `https://${deployUrl}` };
  } catch (err) {
    return { error: err.message };
  }
}
