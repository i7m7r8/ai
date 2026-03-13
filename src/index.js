/**
 * Cloudflare Worker — GPT-OSS-120B with:
 *  ✅ Web Search (Exa API)
 *  ✅ Auto reasoning level (low / medium / high)
 *  ✅ Built-in tools (calculator, date/time, weather)
 *  ✅ OpenAI + Ollama compatible
 *
 * SETUP:
 *  1. Go to https://dashboard.exa.ai → get free API key
 *  2. In Cloudflare Workers dashboard → Settings → Variables
 *     Add secret: EXA_API_KEY = your_exa_key
 *  3. Deploy this worker
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
}

// Detect if a message needs web search
function needsSearch(text) {
  const t = text.toLowerCase();
  return (
    t.includes("latest") || t.includes("current") || t.includes("today") ||
    t.includes("news") || t.includes("price") || t.includes("weather") ||
    t.includes("2025") || t.includes("2026") || t.includes("who is") ||
    t.includes("what is happening") || t.includes("search") ||
    t.includes("find") || t.includes("recent") || t.includes("right now") ||
    t.includes("stock") || t.includes("score") || t.includes("result")
  );
}

// Auto-detect reasoning level from message complexity
function detectReasoningLevel(text) {
  const t = text.toLowerCase();
  const isComplex =
    t.includes("explain") || t.includes("analyze") || t.includes("compare") ||
    t.includes("why") || t.includes("how does") || t.includes("write") ||
    t.includes("debug") || t.includes("code") || t.includes("algorithm") ||
    t.includes("math") || t.includes("solve") || t.length > 300;
  const isSimple =
    t.length < 60 && !isComplex &&
    (t.includes("hello") || t.includes("hi") || t.includes("thanks") ||
     t.includes("what is") || t.includes("who is"));
  if (isSimple) return "low";
  if (isComplex) return "high";
  return "medium";
}

// Built-in tool: calculator
function calculate(expr) {
  try {
    // Safe eval for math expressions only
    const sanitized = expr.replace(/[^0-9+\-*/.()%\s]/g, "");
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return `Calculation result: ${expr} = ${result}`;
  } catch (e) {
    return `Could not calculate: ${expr}`;
  }
}

// Built-in tool: date/time
function getDateTime() {
  const now = new Date();
  return `Current UTC date and time: ${now.toUTCString()}`;
}

// Web search via Exa API
async function webSearch(query, exaApiKey) {
  if (!exaApiKey) return null;
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": exaApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        type: "auto",
        numResults: 5,
        contents: {
          text: true,
          highlights: { numSentences: 3 }
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    const formatted = data.results.map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${
        r.highlights ? r.highlights.join(" ") : (r.text || "").slice(0, 300)
      }`
    ).join("\n\n");

    return `Web search results for "${query}":\n\n${formatted}`;
  } catch (e) {
    return null;
  }
}

// Normalize messages (flatten array content from Chatbox/OpenAI vision format)
function normalizeMessages(rawMessages) {
  return rawMessages.map(msg => {
    let c = msg.content;
    if (Array.isArray(c)) {
      c = c.map(part => {
        if (typeof part === "string") return part;
        if (part && part.type === "text") return part.text || "";
        return "";
      }).join("\n").trim();
    }
    return { role: msg.role, content: c || "" };
  });
}

// Extract text content from AI response (handles all response shapes)
function extractContent(aiResponse) {
  if (!aiResponse) return "";

  // Responses API format: output[].content[].text
  if (Array.isArray(aiResponse.output)) {
    const texts = [];
    for (const block of aiResponse.output) {
      if (block.type === "message" && Array.isArray(block.content)) {
        for (const part of block.content) {
          if ((part.type === "output_text" || part.type === "text") && part.text)
            texts.push(part.text);
        }
      }
      if (typeof block.content === "string") texts.push(block.content);
    }
    if (texts.length > 0) return texts.join("\n");
  }

  // Standard formats
  return (
    aiResponse.response ||
    (aiResponse.result && aiResponse.result.response) ||
    (aiResponse.choices && aiResponse.choices[0] &&
     aiResponse.choices[0].message && aiResponse.choices[0].message.content) ||
    ""
  );
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    const headers = corsHeaders();
    const MODEL_ID   = "@cf/openai/gpt-oss-120b";
    const MODEL_NAME = "gpt-oss-120b";

    // ── Ollama: list models ────────────────────────────────────────────────
    if (url.pathname === "/api/tags") {
      return new Response(JSON.stringify({
        models: [{
          name: MODEL_NAME, model: MODEL_NAME,
          modified_at: "2025-08-05T00:00:00Z",
          size: 120000000000, digest: "gptoss120b",
          details: { format: "gguf", family: "openai", parameter_size: "120B", quantization_level: "FP8" }
        }]
      }), { headers });
    }

    // ── OpenAI: list models ────────────────────────────────────────────────
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: MODEL_NAME, object: "model", created: 1754352000, owned_by: "openai" }]
      }), { headers });
    }

    // ── Parse body ─────────────────────────────────────────────────────────
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim().length > 0) body = JSON.parse(text);
    } catch (e) {
      body = {};
    }

    // ── Normalize messages ─────────────────────────────────────────────────
    const rawMessages = body.messages || [
      { role: "user", content: body.prompt || "Hello" }
    ];
    const messages = normalizeMessages(rawMessages);

    // Keep last 20 messages (128k context window — generous but safe)
    const trimmedMessages = messages.slice(-20);

    // Get the latest user message
    const lastUserMsg = [...trimmedMessages].reverse()
      .find(m => m.role === "user");
    const userText = lastUserMsg ? lastUserMsg.content : "";

    // ── Auto reasoning level ───────────────────────────────────────────────
    const reasoningLevel = detectReasoningLevel(userText);

    // ── Built-in tools (pre-process before AI call) ────────────────────────
    let toolContext = "";

    // Date/time tool — always inject current time
    toolContext += getDateTime() + "\n";

    // Calculator tool — detect math expressions
    const calcMatch = userText.match(
      /calculate|compute|what is\s+[\d]|=\s*\?|(\d+[\s]*[+\-*/^%]+[\s]*\d+)/i
    );
    if (calcMatch) {
      const exprMatch = userText.match(/([\d\s+\-*/.()%]+)/);
      if (exprMatch) {
        toolContext += calculate(exprMatch[1].trim()) + "\n";
      }
    }

    // ── Web search ─────────────────────────────────────────────────────────
    const exaKey = env.EXA_API_KEY || "";
    if (needsSearch(userText) && exaKey) {
      // Extract clean search query from user message
      const searchQuery = userText
        .replace(/can you|please|search for|find|tell me about/gi, "")
        .trim()
        .slice(0, 200);
      const searchResults = await webSearch(searchQuery, exaKey);
      if (searchResults) toolContext += "\n" + searchResults + "\n";
    }

    // ── Inject tool context as system message ──────────────────────────────
    let finalMessages = trimmedMessages;
    if (toolContext.trim()) {
      const systemMsg = {
        role: "system",
        content:
          "You are a helpful AI assistant. Use the following real-time context to answer accurately:\n\n" +
          toolContext +
          "\nAlways cite search results when used. Be concise and helpful."
      };
      // Prepend system message (or replace existing one)
      const hasSystem = finalMessages[0] && finalMessages[0].role === "system";
      finalMessages = hasSystem
        ? [systemMsg, ...finalMessages.slice(1)]
        : [systemMsg, ...finalMessages];
    }

    // ── Call Cloudflare Workers AI ─────────────────────────────────────────
    let content = "";
    try {
      const aiResponse = await env.AI.run(
        MODEL_ID,
        {
          messages: finalMessages,
          max_tokens: 8192,
          reasoning: { effort: reasoningLevel }
        }
      );
      content = extractContent(aiResponse);
    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: err.message, type: "ai_error" }
      }), { status: 500, headers });
    }

    // ── Ollama: /api/chat ──────────────────────────────────────────────────
    if (url.pathname === "/api/chat") {
      return new Response(JSON.stringify({
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content },
        done_reason: "stop", done: true,
        total_duration: 1000000000,
        load_duration: 0, prompt_eval_count: 0,
        prompt_eval_duration: 0, eval_count: 0, eval_duration: 0
      }), { headers });
    }

    // ── Ollama: /api/generate ──────────────────────────────────────────────
    if (url.pathname === "/api/generate") {
      return new Response(JSON.stringify({
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        response: content, done: true, done_reason: "stop"
      }), { headers });
    }

    // ── OpenAI: /v1/chat/completions ───────────────────────────────────────
    const openAIResponse = JSON.stringify({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_NAME,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });

    if (
      url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions"
    ) {
      return new Response(openAIResponse, { headers });
    }

    // ── Fallback ───────────────────────────────────────────────────────────
    return new Response(openAIResponse, { headers });
  }
};
