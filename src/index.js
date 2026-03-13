/**
 * Cloudflare Worker — GPT-OSS-120B with:
 *  ✅ Web Search (Exa API)
 *  ✅ Auto reasoning level (low / medium / high)
 *  ✅ Built-in tools (calculator, date/time)
 *  ✅ OpenAI + Ollama compatible
 */

function getCorsHeaders() {
  return { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
}

function needsSearch(text) {
  const t = text.toLowerCase();
  return (
    t.includes("latest") || t.includes("current") || t.includes("today") ||
    t.includes("news") || t.includes("price") || t.includes("weather") ||
    t.includes("2025") || t.includes("2026") || t.includes("who is") ||
    t.includes("search") || t.includes("find") || t.includes("recent") ||
    t.includes("right now") || t.includes("stock") || t.includes("score")
  );
}

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

function calculate(expr) {
  try {
    const sanitized = expr.replace(/[^0-9+\-*/.()%\s]/g, "");
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return `Calculation result: ${expr} = ${result}`;
  } catch (e) {
    return null;
  }
}

async function webSearch(query, exaApiKey) {
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
      contents: { text: true, highlights: { numSentences: 3 } }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log("EXA ERROR:", res.status, errText);
    return null;
  }

  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;

  return data.results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\n${
      r.highlights ? r.highlights.join(" ") : (r.text || "").slice(0, 300)
    }`
  ).join("\n\n");
}

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

function extractContent(aiResponse) {
  if (!aiResponse) return "";
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
  return (
    aiResponse.response ||
    (aiResponse.result && aiResponse.result.response) ||
    (aiResponse.choices &&
      aiResponse.choices[0] &&
      aiResponse.choices[0].message &&
      aiResponse.choices[0].message.content) ||
    ""
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = getCorsHeaders();
    const MODEL_ID   = "@cf/openai/gpt-oss-120b";
    const MODEL_NAME = "gpt-oss-120b";

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

    // ── DEBUG endpoint — visit in browser to confirm secrets ────────────────
    // REMOVE THIS after confirming Exa works!
    if (url.pathname === "/debug") {
      return new Response(JSON.stringify({
        exa_key_set: !!(env.EXA_API_KEY),
        exa_key_length: env.EXA_API_KEY ? env.EXA_API_KEY.length : 0,
        ai_binding: !!(env.AI)
      }), { headers });
    }

    // ── Ollama: list models ──────────────────────────────────────────────────
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

    // ── OpenAI: list models ──────────────────────────────────────────────────
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: MODEL_NAME, object: "model", created: 1754352000, owned_by: "openai" }]
      }), { headers });
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim().length > 0) body = JSON.parse(text);
    } catch (e) { body = {}; }

    // ── Normalize + trim messages ────────────────────────────────────────────
    const rawMessages = body.messages || [
      { role: "user", content: body.prompt || "Hello" }
    ];
    const messages = normalizeMessages(rawMessages).slice(-20);

    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const userText = lastUserMsg ? lastUserMsg.content : "";

    // ── Auto reasoning level ─────────────────────────────────────────────────
    const reasoningLevel = detectReasoningLevel(userText);

    // ── Tool context ─────────────────────────────────────────────────────────
    let toolContext = "Current UTC time: " + new Date().toUTCString() + "\n";

    // Calculator
    const calcMatch = userText.match(/([\d\s+\-*/.()%]{3,})/);
    if (calcMatch && /[+\-*/]/.test(calcMatch[1])) {
      const result = calculate(calcMatch[1].trim());
      if (result) toolContext += result + "\n";
    }

    // ── Web search ───────────────────────────────────────────────────────────
    const exaKey = (env.EXA_API_KEY || "967d01bd-2a63-4b9c-a17e-4351d09fadb2").trim();
    console.log("EXA KEY SET:", !!exaKey, "| LENGTH:", exaKey.length);
    console.log("NEEDS SEARCH:", needsSearch(userText), "| USER TEXT:", userText.slice(0, 100));

    if (needsSearch(userText) && exaKey) {
      try {
        const searchQuery = userText
          .replace(/can you|please|search for|find|tell me about/gi, "")
          .trim()
          .slice(0, 200);
        console.log("SEARCHING FOR:", searchQuery);
        const searchResults = await webSearch(searchQuery, exaKey);
        if (searchResults) {
          toolContext += "\n\nWeb search results:\n" + searchResults + "\n";
          console.log("SEARCH SUCCESS: got results");
        } else {
          console.log("SEARCH: no results returned");
        }
      } catch (e) {
        console.log("SEARCH EXCEPTION:", e.message);
      }
    }

    // ── Build final messages with system context ─────────────────────────────
    const systemMsg = {
      role: "system",
      content:
        "You are a helpful AI assistant. Use this real-time context:\n\n" +
        toolContext +
        "\nCite sources when using search results. Be accurate and concise."
    };
    const hasSystem = messages[0] && messages[0].role === "system";
    const finalMessages = hasSystem
      ? [systemMsg, ...messages.slice(1)]
      : [systemMsg, ...messages];

    // ── Call AI ──────────────────────────────────────────────────────────────
    let content = "";
    try {
      const aiResponse = await env.AI.run(MODEL_ID, {
        messages: finalMessages,
        max_tokens: 8192,
        reasoning: { effort: reasoningLevel }
      });
      content = extractContent(aiResponse);
    } catch (err) {
      console.log("AI ERROR:", err.message);
      return new Response(JSON.stringify({
        error: { message: err.message, type: "ai_error" }
      }), { status: 500, headers });
    }

    const openAIBody = JSON.stringify({
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

    if (url.pathname === "/api/generate") {
      return new Response(JSON.stringify({
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        response: content, done: true, done_reason: "stop"
      }), { headers });
    }

    return new Response(openAIBody, { headers });
  }
};
