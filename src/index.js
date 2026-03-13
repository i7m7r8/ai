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

    const corsHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    };

    // ── Ollama: list models ──────────────────────────────────────────────────
    if (url.pathname === "/api/tags") {
      return new Response(JSON.stringify({
        models: [{
          name: "qwen2.5-coder-32b",
          model: "qwen2.5-coder-32b",
          modified_at: "2025-01-01T00:00:00Z",
          size: 19000000000,
          digest: "abc123",
          details: {
            format: "gguf",
            family: "qwen",
            parameter_size: "32B",
            quantization_level: "Q4_K_M"
          }
        }]
      }), { headers: corsHeaders });
    }

    // ── OpenAI: list models ──────────────────────────────────────────────────
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          id: "qwen2.5-coder-32b",
          object: "model",
          created: 1700000000,
          owned_by: "cloudflare"
        }]
      }), { headers: corsHeaders });
    }

    // ── Parse body safely (handles empty / malformed body) ───────────────────
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch (e) {
      body = {};
    }

    const messages = body.messages || [
      { role: "user", content: body.prompt || "Hello" }
    ];

    // ── Call Cloudflare Workers AI ───────────────────────────────────────────
    let content = "";
    try {
      const aiResponse = await env.AI.run(
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        { messages, max_tokens: 8192 }   // ✅ no stream:false
      );

      // Safely extract content from whatever shape the response has
      content =
        aiResponse?.response ??
        aiResponse?.result?.response ??
        aiResponse?.choices?.[0]?.message?.content ??
        "";

      if (!content) {
        console.error("Empty AI response. Full object:", JSON.stringify(aiResponse));
      }

    } catch (err) {
      console.error("AI run error:", err.message);
      return new Response(JSON.stringify({
        error: { message: err.message, type: "ai_error" }
      }), { status: 500, headers: corsHeaders });
    }

    // ── Ollama: /api/chat ────────────────────────────────────────────────────
    if (url.pathname === "/api/chat") {
      return new Response(JSON.stringify({
        model: "qwen2.5-coder-32b",
        created_at: new Date().toISOString(),
        message: {
          role: "assistant",
          content: content
        },
        done_reason: "stop",
        done: true,
        total_duration: 1000000000,
        load_duration: 0,
        prompt_eval_count: 0,
        prompt_eval_duration: 0,
        eval_count: 0,
        eval_duration: 0
      }), { headers: corsHeaders });
    }

    // ── Ollama: /api/generate ────────────────────────────────────────────────
    if (url.pathname === "/api/generate") {
      return new Response(JSON.stringify({
        model: "qwen2.5-coder-32b",
        created_at: new Date().toISOString(),
        response: content,
        done: true,
        done_reason: "stop"
      }), { headers: corsHeaders });
    }

    // ── OpenAI: /v1/chat/completions  (Chatbox AI uses this) ─────────────────
    if (
      url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions"
    ) {
      return new Response(JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "qwen2.5-coder-32b",
        choices: [{
          index: 0,
          message: { role: "assistant", content: content },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }), { headers: corsHeaders });
    }

    // ── Fallback: root "/" or anything else → OpenAI format ──────────────────
    return new Response(JSON.stringify({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "qwen2.5-coder-32b",
      choices: [{
        index: 0,
        message: { role: "assistant", content: content },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), { headers: corsHeaders });
  }
};
