/**
 * Cloudflare Worker — Multi-Provider AI with Auto Fallback
 * FIXED: Proper OpenAI SSE streaming format for Qwen Code
 */

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
      body: JSON.stringify({
        query: query,
        type: "auto",
        numResults: 5,
        contents: { text: true, highlights: { numSentences: 3 } }
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
    return null;  }
}

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

async function callGroq(messages, groqKey, stream) {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + groqKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: messages,
        max_tokens: 16384,
        stream: stream
      })
    });
    if (!res.ok) return { ok: false, error: "Groq HTTP " + res.status };
    if (stream) return { ok: true, stream: res.body };
    const data = await res.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content || "" : "";
    return { ok: true, content: content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function callCloudflare(env, messages, stream) {
  try {
    const aiResponse = await env.AI.run(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      { messages: messages, max_tokens: 16384, stream: stream }
    );
    if (stream) return { ok: true, stream: aiResponse };    let content = "";
    if (Array.isArray(aiResponse && aiResponse.output)) {
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
    if (!content) {
      content = (aiResponse && aiResponse.response) ||
                (aiResponse && aiResponse.result && aiResponse.result.response) ||
                (aiResponse && aiResponse.choices && aiResponse.choices[0] &&
                 aiResponse.choices[0].message && aiResponse.choices[0].message.content) || "";
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
      const MODEL_NAME = "llama-4-scout";

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
            "Access-Control-Allow-Headers": "Content-Type, Authorization"          }
        });
      }

      // Debug endpoint
      if (url.pathname === "/debug") {
        return new Response(JSON.stringify({
          exa_key_set: !!(env.EXA_API_KEY),
          groq_key_set: !!(env.GROQ_API_KEY),
          ai_binding: !!(env.AI),
          model: MODEL_NAME
        }), { headers: jsonHeaders });
      }

      // Ollama: list models
      if (url.pathname === "/api/tags") {
        return new Response(JSON.stringify({
          models: [{
            name: MODEL_NAME,
            model: MODEL_NAME,
            modified_at: "2025-04-05T00:00:00Z",
            size: 17000000000,
            digest: "llama4scout",
            details: {
              format: "gguf",
              family: "meta",
              parameter_size: "17Bx16E",
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
            created: 1743811200,
            owned_by: "meta"
          }]
        }), { headers: jsonHeaders });
      }

      // Parse body
      let body = {};
      try {
        const text = await request.text();        if (text && text.trim().length > 0) body = JSON.parse(text);
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
        } catch (e) { /* ignore */ }
      }

      // Build final messages
      const systemMsg = {
        role: "system",
        content: "You are a helpful AI assistant. Use this real-time context:\n\n" +
                 toolContext + "\nCite sources when using search results. Be accurate and concise."
      };
      const hasSystem = messages[0] && messages[0].role === "system";
      const finalMessages = hasSystem
        ? [systemMsg].concat(messages.slice(1))
        : [systemMsg].concat(messages);

      const groqKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim() : null;
      if (!groqKey && !env.AI) {
        return new Response(JSON.stringify({
          error: { message: "No API keys configured", type: "config_error" }
        }), { status: 500, headers: jsonHeaders });
      }
      const id = "chatcmpl-" + Date.now();
      const created = Math.floor(Date.now() / 1000);
      const encoder = new TextEncoder();

      // STREAMING - FIXED for Qwen Code
      if (wantsStream) {
        // Try Groq first
        if (groqKey) {
          const groqResult = await callGroq(finalMessages, groqKey, true);
          if (groqResult.ok && groqResult.stream) {
            return new Response(groqResult.stream, { headers: sseHeaders });
          }
        }

        // Cloudflare fallback - FIXED with proper finish_reason
        const cfResult = await callCloudflare(env, finalMessages, false);
        if (cfResult.ok) {
          const content = cfResult.content || "";
          const stream = new ReadableStream({
            async start(controller) {
              // Content chunk with role
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
              
              // Final chunk with finish_reason: "stop" (CRITICAL for Qwen Code)
              controller.enqueue(encoder.encode(
                "data: " + JSON.stringify({
                  id: id,
                  object: "chat.completion.chunk",
                  created: created,
                  model: MODEL_NAME,
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
          error: { message: cfResult.error || "All providers failed", type: "ai_error" }
        }), { status: 500, headers: jsonHeaders });
      }

      // NON-STREAMING
      if (groqKey) {
        const groqResult = await callGroq(finalMessages, groqKey, false);
        if (groqResult.ok && groqResult.content !== undefined) {
          const content = groqResult.content;
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
      }

      // Cloudflare fallback
      const cfResult = await callCloudflare(env, finalMessages, false);
      if (cfResult.ok) {
        const content = cfResult.content || "";
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
      return new Response(JSON.stringify({
        error: { message: cfResult.error || "All providers failed", type: "ai_error" }
      }), { status: 500, headers: jsonHeaders });

    } catch (err) {
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
