/**
 * Cloudflare Pages/Worker — Qwen AI API with Auto Fallback
 * ✅ Primary: Qwen3-30B-A3B-FP8 (Most powerful Qwen on CF AI) [[20]]
 * ✅ Fallback: Qwen2.5-Coder-32B-Instruct (Best for coding) [[22]]
 * ✅ Auto-rotates when one model hits rate limit or errors
 * ✅ Web Search (Exa API)
 * ✅ OpenAI + Ollama Compatible Streaming
 * ✅ Proper SSE format for Qwen Code CLI
 */

function needsSearch(text) {
  const t = text.toLowerCase();
  return (
    t.includes("latest") ||
    t.includes("current") ||
    t.includes("today") ||
    t.includes("news") ||
    t.includes("price") ||
    t.includes("weather") ||
    t.includes("2025") ||
    t.includes("2026") ||
    t.includes("who is") ||
    t.includes("search") ||
    t.includes("find") ||
    t.includes("recent") ||
    t.includes("right now") ||
    t.includes("stock") ||
    t.includes("score")
  );
}

function calculate(expr) {
  try {
    const sanitized = expr.replace(/[^0-9+\-*/.()%\s]/g, "");
    const result = Function('"use strict"; return (' + sanitized + ')')();
    return "Calculation: " + expr + " = " + result;
  } catch (e) {
    return null;
  }
}

async function webSearch(query, exaApiKey) {
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": exaApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({        query: query,
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
    return data.results.map(function(r, i) {
      return "[" + (i+1) + "] " + r.title + "\nURL: " + r.url + "\n" +
        (r.highlights ? r.highlights.join(" ") : (r.text || "").slice(0, 300));
    }).join("\n\n");
  } catch (e) {
    return null;
  }
}

// Flatten array content [{type:"text",text:"..."}] → plain string
function normalizeMessages(rawMessages) {
  return rawMessages.map(function(msg) {
    let c = msg.content;
    if (Array.isArray(c)) {
      c = c.map(function(part) {
        if (typeof part === "string") return part;
        if (part && part.type === "text") return part.text || "";
        return "";
      }).join("\n").trim();
    }
    return { role: msg.role, content: c || "" };
  });
}

// Call Qwen3-30B via Cloudflare AI Binding — returns { ok, content, stream }
async function callQwen3(env, messages, stream) {
  try {
    const aiResponse = await env.AI.run(
      "@cf/qwen/qwen3-30b-a3b-fp8",  // Most powerful Qwen on CF AI [[20]]
      {
        messages: messages,
        max_tokens: 16384,
        stream: stream,
        temperature: 0.7
      }
    );

    if (stream) {      return { ok: true, stream: aiResponse };
    }

    // Extract content from all possible shapes
    let content = "";
    if (aiResponse && aiResponse.response) {
      content = aiResponse.response;
    } else if (aiResponse && aiResponse.result && aiResponse.result.response) {
      content = aiResponse.result.response;
    } else if (Array.isArray(aiResponse && aiResponse.output)) {
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
      if (texts.length > 0) content = texts.join("\n");
    }
    
    return { ok: true, content: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Call Qwen2.5-Coder-32B via Cloudflare AI Binding — returns { ok, content, stream }
async function callQwenCoder(env, messages, stream) {
  try {
    const aiResponse = await env.AI.run(
      "@cf/qwen/qwen2.5-coder-32b-instruct",  // Best for coding [[22]]
      {
        messages: messages,
        max_tokens: 16384,
        stream: stream,
        temperature: 0.7
      }
    );

    if (stream) {
      return { ok: true, stream: aiResponse };
    }

    let content = "";
    if (aiResponse && aiResponse.response) {
      content = aiResponse.response;
    } else if (aiResponse && aiResponse.result && aiResponse.result.response) {      content = aiResponse.result.response;
    } else if (Array.isArray(aiResponse && aiResponse.output)) {
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
      if (texts.length > 0) content = texts.join("\n");
    }
    
    return { ok: true, content: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const MODEL_NAME = "qwen3-30b-a3b-fp8";

      const jsonHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      };
      const sseHeaders = {
        "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      };

      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          }
        });
      }

      // Debug endpoint      if (url.pathname === "/debug") {
        return new Response(JSON.stringify({
          exa_key_set: !!(env.EXA_API_KEY),
          ai_binding: !!(env.AI),
          primary_model: "@cf/qwen/qwen3-30b-a3b-fp8",
          fallback_model: "@cf/qwen/qwen2.5-coder-32b-instruct"
        }), { headers: jsonHeaders });
      }

      // Ollama: list models
      if (url.pathname === "/api/tags") {
        return new Response(JSON.stringify({
          models: [{
            name: MODEL_NAME,
            model: MODEL_NAME,
            modified_at: "2026-01-01T00:00:00Z",
            size: 30000000000,
            digest: "qwen3-30b",
            details: {
              format: "gguf",
              family: "qwen",
              parameter_size: "30B-A3B",
              quantization_level: "FP8"
            }
          }]
        }), { headers: jsonHeaders });
      }

      // OpenAI: list models
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        return new Response(JSON.stringify({
          object: "list",
          data: [{
            id: MODEL_NAME,
            object: "model",
            created: 1735689600,
            owned_by: "qwen"
          }]
        }), { headers: jsonHeaders });
      }

      // Parse body
      let body = {};
      try {
        const text = await request.text();
        if (text && text.trim().length > 0) body = JSON.parse(text);
      } catch (e) {
        body = {};
      }
      const wantsStream = body.stream === true;

      // Normalize messages
      const rawMessages = body.messages || [{ role: "user", content: body.prompt || "Hello" }];
      const messages = normalizeMessages(rawMessages);

      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      const userText = lastUserMsg ? lastUserMsg.content : "";

      // Tool context
      let toolContext = "Current UTC time: " + new Date().toUTCString() + "\n";
      const calcMatch = userText.match(/([\d\s+\-*/.()%]{3,})/);
      if (calcMatch && /[+\-*/]/.test(calcMatch[1])) {
        const result = calculate(calcMatch[1].trim());
        if (result) toolContext += result + "\n";
      }

      // Web search
      const exaKey = env.EXA_API_KEY ? env.EXA_API_KEY.trim() : null;
      if (needsSearch(userText) && exaKey) {
        try {
          const q = userText.replace(/can you|please|search for|find|tell me about/gi, "").trim().slice(0, 200);
          const results = await webSearch(q, exaKey);
          if (results) toolContext += "\n\nWeb search results:\n" + results + "\n";
        } catch (e) {
          // ignore search errors
        }
      }

      // Build final messages
      const systemMsg = {
        role: "system",
        content: "You are a helpful AI assistant. Use this real-time context:\n\n" +
                 toolContext +
                 "\nCite sources when using search results. Be accurate and concise."
      };
      const hasSystem = messages[0] && messages[0].role === "system";
      const finalMessages = hasSystem
        ? [systemMsg].concat(messages.slice(1))
        : [systemMsg].concat(messages);

      // Check AI binding exists
      if (!env.AI) {
        return new Response(JSON.stringify({
          error: { message: "AI binding not configured. Add [ai] section to wrangler.toml", type: "config_error" }
        }), { status: 500, headers: jsonHeaders });
      }

      const id = "chatcmpl-" + Date.now();
      const created = Math.floor(Date.now() / 1000);      const encoder = new TextEncoder();

      // STREAMING - Fixed for Qwen Code CLI compatibility
      if (wantsStream) {
        // Try Qwen3-30B first (most powerful) [[20]]
        const qwen3Result = await callQwen3(env, finalMessages, false); // Use non-streaming, convert to SSE
        
        if (qwen3Result.ok && qwen3Result.content !== undefined) {
          const content = qwen3Result.content;
          const stream = new ReadableStream({
            async start(controller) {
              // Send content chunk with role
              controller.enqueue(encoder.encode(
                "data: " + JSON.stringify({
                  id: id,
                  object: "chat.completion.chunk",
                  created: created,
                  model: MODEL_NAME,
                  choices: [{
                    index: 0,
                    delta: { role: "assistant", content: content },
                    finish_reason: null
                  }]
                }) + "\n\n"
              ));
              
              // Send final chunk with finish_reason: "stop" (CRITICAL for Qwen Code)
              controller.enqueue(encoder.encode(
                "data: " + JSON.stringify({
                  id: id,
                  object: "chat.completion.chunk",
                  created: created,
                  model: MODEL_NAME,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop"  // Qwen Code needs this!
                  }]
                }) + "\n\n"
              ));
              
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          });
          return new Response(stream, { headers: sseHeaders });
        }

        // Fallback to Qwen2.5-Coder-32B [[22]]
        const coderResult = await callQwenCoder(env, finalMessages, false);        if (coderResult.ok) {
          const content = coderResult.content || "";
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(
                "data: " + JSON.stringify({
                  id: id,
                  object: "chat.completion.chunk",
                  created: created,
                  model: "qwen2.5-coder-32b-instruct",
                  choices: [{
                    index: 0,
                    delta: { role: "assistant", content: content },
                    finish_reason: null
                  }]
                }) + "\n\n"
              ));
              
              controller.enqueue(encoder.encode(
                "data: " + JSON.stringify({
                  id: id,
                  object: "chat.completion.chunk",
                  created: created,
                  model: "qwen2.5-coder-32b-instruct",
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: "stop"
                  }]
                }) + "\n\n"
              ));
              
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          });
          return new Response(stream, { headers: sseHeaders });
        }

        return new Response(JSON.stringify({
          error: { message: coderResult.error || "All models failed", type: "ai_error" }
        }), { status: 500, headers: jsonHeaders });
      }

      // NON-STREAMING
      // Try Qwen3-30B first (most powerful) [[20]]
      const qwen3Result = await callQwen3(env, finalMessages, false);
      if (qwen3Result.ok && qwen3Result.content !== undefined) {
        const content = qwen3Result.content;
                // Ollama format
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
          }), { headers: jsonHeaders });
        }
        
        // Ollama generate format
        if (url.pathname === "/api/generate") {
          return new Response(JSON.stringify({
            model: MODEL_NAME,
            created_at: new Date().toISOString(),
            response: content,
            done: true,
            done_reason: "stop"
          }), { headers: jsonHeaders });
        }
        
        // OpenAI compatible format
        return new Response(JSON.stringify({
          id: id,
          object: "chat.completion",
          created: created,
          model: MODEL_NAME,
          choices: [{
            index: 0,
            message: { role: "assistant", content: content },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }), { headers: jsonHeaders });
      }

      // Fallback to Qwen2.5-Coder-32B [[22]]
      const coderResult = await callQwenCoder(env, finalMessages, false);
      if (coderResult.ok) {
        const content = coderResult.content || "";
        
        if (url.pathname === "/api/chat") {
          return new Response(JSON.stringify({            model: "qwen2.5-coder-32b-instruct",
            created_at: new Date().toISOString(),
            message: { role: "assistant", content: content },
            done_reason: "stop",
            done: true
          }), { headers: jsonHeaders });
        }
        
        if (url.pathname === "/api/generate") {
          return new Response(JSON.stringify({
            model: "qwen2.5-coder-32b-instruct",
            created_at: new Date().toISOString(),
            response: content,
            done: true,
            done_reason: "stop"
          }), { headers: jsonHeaders });
        }
        
        return new Response(JSON.stringify({
          id: id,
          object: "chat.completion",
          created: created,
          model: "qwen2.5-coder-32b-instruct",
          choices: [{
            index: 0,
            message: { role: "assistant", content: content },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }), { headers: jsonHeaders });
      }

      return new Response(JSON.stringify({
        error: { message: coderResult.error || "All models failed", type: "ai_error" }
      }), { status: 500, headers: jsonHeaders });

    } catch (err) {
      // Global error handler
      return new Response(JSON.stringify({
        error: { message: err.message, type: "internal_error" }
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
