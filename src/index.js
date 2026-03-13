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

    const MODEL_ID   = "@cf/openai/gpt-oss-120b";
    const MODEL_NAME = "gpt-oss-120b";

    // ── Ollama: list models ──────────────────────────────────────────────────
    if (url.pathname === "/api/tags") {
      return new Response(JSON.stringify({
        models: [{
          name: MODEL_NAME,
          model: MODEL_NAME,
          modified_at: "2025-08-05T00:00:00Z",
          size: 120000000000,
          digest: "gptoss120b",
          details: {
            format: "gguf",
            family: "openai",
            parameter_size: "120B",
            quantization_level: "FP8"
          }
        }]
      }), { headers: corsHeaders });
    }

    // ── OpenAI: list models ──────────────────────────────────────────────────
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          id: MODEL_NAME,
          object: "model",
          created: 1754352000,
          owned_by: "openai"
        }]
      }), { headers: corsHeaders });
    }

    // ── Parse body safely ────────────────────────────────────────────────────
    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch (e) {
      body = {};
    }

    // ── Normalize messages ───────────────────────────────────────────────────
    // Flatten any array content [{type:"text",text:"..."}] → plain string
    const rawMessages = body.messages || [
      { role: "user", content: body.prompt || "Hello" }
    ];

    const messages = rawMessages.map(msg => {
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

    // Keep last 20 messages to avoid context overflow (128k window)
    const trimmedMessages = messages.slice(-20);

    // ── Call Cloudflare Workers AI (gpt-oss-120b) ────────────────────────────
    let content = "";
    try {
      const aiResponse = await env.AI.run(
        MODEL_ID,
        {
          messages: trimmedMessages,
          max_tokens: 8192,
          reasoning: { effort: "medium" }  // low | medium | high
        }
      );

      // gpt-oss-120b returns Responses API format:
      // { output: [{ type:"message", content:[{ type:"output_text", text:"..." }] }] }
      // But also supports standard: { response: "..." }
      // Handle all possible shapes:
      content =
        // Responses API format
        (aiResponse?.output?.[0]?.content?.[0]?.text) ||
        (aiResponse?.output?.[0]?.content) ||
        // Standard chat format
        (aiResponse?.response) ||
        (aiResponse?.result?.response) ||
        (aiResponse?.choices?.[0]?.message?.content) ||
        "";

      // If output is an array of content blocks, join them
      if (Array.isArray(aiResponse?.output)) {
        const texts = [];
        for (const block of aiResponse.output) {
          if (block.type === "message" && Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === "output_text" && part.text) texts.push(part.text);
              if (part.type === "text" && part.text) texts.push(part.text);
            }
          }
          if (typeof block.content === "string") texts.push(block.content);
        }
        if (texts.length > 0) content = texts.join("\n");
      }

    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: err.message, type: "ai_error" }
      }), { status: 500, headers: corsHeaders });
    }

    // ── Ollama: /api/chat ────────────────────────────────────────────────────
    if (url.pathname === "/api/chat") {
      return new Response(JSON.stringify({
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: content },
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
        model: MODEL_NAME,
        created_at: new Date().toISOString(),
        response: content,
        done: true,
        done_reason: "stop"
      }), { headers: corsHeaders });
    }

    // ── OpenAI: /v1/chat/completions (Chatbox AI & all apps use this) ─────────
    if (
      url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions"
    ) {
      return new Response(JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_NAME,
        choices: [{
          index: 0,
          message: { role: "assistant", content: content },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }), { headers: corsHeaders });
    }

    // ── Fallback: root "/" or anything else ──────────────────────────────────
    return new Response(JSON.stringify({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_NAME,
      choices: [{
        index: 0,
        message: { role: "assistant", content: content },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), { headers: corsHeaders });
  }
};
