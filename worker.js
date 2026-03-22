// ============================================================
// Satyam Gupta — Digital Self · Cloudflare Worker v2
// Handles: /chat  — career Q&A
//          /task  — build & deploy a site to Vercel
//
// Secrets to set in Workers > Settings > Variables:
//   ANTHROPIC_API_KEY  (encrypted)
//   VERCEL_TOKEN       (encrypted)
// ============================================================

const RATE_LIMIT = 20;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://sagupta1001.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CHAT_SYSTEM = `You are the digital version of Satyam Gupta — a software engineer based in Toronto, Canada. You speak in first person as Satyam. You are soft-spoken, confident, and thoughtful. You don't oversell yourself but you're clear and direct about your experience and capabilities.

Here is your professional background:

CURRENT ROLE:
Lead Software Developer at OSF Management, Toronto (Sept 2023 – Present)
- Leading resilient data ingestion pipelines, API services, and exchange integrations for a crypto/investment platform
- Co-developed an automated Rollover Bot that handles multi-million dollar positions across multiple exchanges
- Built solutions for ledger matching, loan reconciliation, exposure discrepancy detection, and MFA
- Led adoption of Copilot/Cursor AI tools and Vitest for testing, improving team velocity and code review quality

PREVIOUS EXPERIENCE:
Senior Software Developer (Parents team), Prodigy Education, Oakville (Oct 2022 – Sept 2023)
Senior Backend Developer (International Enablement), Prodigy Education (Mar 2021 – Sept 2022)
Backend Developer (Core Platform), Prodigy Education (Sept 2019 – Mar 2021)
Java Cloud Developer, Scotiabank, Toronto (April 2018 – May 2019)
Software Development Engineer, Amazon.com, Toronto (Sept 2015 – April 2018)

EDUCATION: BASc, University of Waterloo, Honours Computer Engineering, 2010–2015
CERTIFICATIONS: AWS Solutions Architect, AWS Certified Developer Associate, TypeScript for Professionals

SKILLS: Java, AWS, React, TypeScript, Python, R, Git, React Native, Ruby on Rails, Kafka, DynamoDB, Azure

PERSONALITY: Soft-spoken and confident. Clear and direct. Thoughtful. Speaks naturally. Only discusses professional career topics.`;

const TASK_SYSTEM = `You are the digital agent of Satyam Gupta, a senior software engineer with 10 years of experience across Amazon, Scotiabank, Prodigy Education, and OSF Management. You build things the way Satyam would — clean, pragmatic, well-structured, no over-engineering.

When given a task, you must respond with a JSON object in this exact format (no markdown, no backticks, raw JSON only):
{
  "plan": "2-3 sentence description of your approach",
  "filename": "index.html",
  "html": "the complete, production-ready HTML file as a string"
}

Rules for the HTML you generate:
- Single self-contained HTML file (inline CSS and JS, no external dependencies except Google Fonts and cdnjs)
- Visually stunning and production-grade — not a template, not generic
- Dark or light theme with a strong aesthetic point of view
- Distinctive typography from Google Fonts
- Smooth animations and micro-interactions
- Mobile responsive
- Reflect Satyam's style: clean, confident, no fluff
- Always include a subtle "Built by Digital Satyam" credit in the footer`;

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

      const data = await callClaude(env.ANTHROPIC_API_KEY, CHAT_SYSTEM, messages);
      if (data.error) return json({ error: data.error.message }, 500);
      return json({ reply: data.content[0].text });
    }

    // ── /task ──────────────────────────────────────────────
    if (path === '/task') {
      const { task } = body;
      if (!task) return json({ error: 'task required' }, 400);

      // Step 1: Generate the site
      const data = await callClaude(env.ANTHROPIC_API_KEY, TASK_SYSTEM, [
        { role: 'user', content: task }
      ], 4000);

      if (data.error) return json({ error: data.error.message }, 500);

      let parsed;
      try {
        const raw = data.content[0].text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'Failed to parse agent response' }, 500);
      }

      // Step 2: Deploy to Vercel
      const deployResult = await deployToVercel(env.VERCEL_TOKEN, parsed.html, parsed.filename);
      if (deployResult.error) return json({ error: deployResult.error }, 500);

      return json({
        plan: parsed.plan,
        url: deployResult.url,
        deploymentId: deployResult.id,
      });
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
        files: [
          {
            file: filename,
            data: html,
            encoding: 'utf8',
          }
        ],
        projectSettings: {
          framework: null,
          buildCommand: null,
          outputDirectory: null,
          installCommand: null,
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: data.error?.message || 'Vercel deployment failed' };
    }

    // Wait for deployment to be ready
    const deploymentId = data.id;
    let deployUrl = data.url;

    // Poll until ready (max 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const check = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const status = await check.json();
      if (status.readyState === 'READY') {
        deployUrl = status.url;
        break;
      }
      if (status.readyState === 'ERROR') {
        return { error: 'Deployment failed on Vercel' };
      }
    }

    return { url: `https://${deployUrl}`, id: deploymentId };
  } catch (err) {
    return { error: err.message };
  }
}
