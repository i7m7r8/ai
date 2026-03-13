export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    // Ollama tags endpoint — Maid uses this to list models
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
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // OpenAI models endpoint
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{
          id: "qwen2.5-coder-32b",
          object: "model",
          created: 1700000000,
          owned_by: "cloudflare"
        }]
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    try {
      const body = await request.json();
      const messages = body.messages || [
        { role: "user", content: body.prompt || "Hello" }
      ];

      const response = await env.AI.run(
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        { messages, max_tokens: 8192, stream: false }
      );

      const content = response.response ?? "";

      // Ollama /api/chat response — exact format Maid expects
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
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // Ollama /api/generate response
      if (url.pathname === "/api/generate") {
        return new Response(JSON.stringify({
          model: "qwen2.5-coder-32b",
          created_at: new Date().toISOString(),
          response: content,
          done: true,
          done_reason: "stop"
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // OpenAI fallback
      return new Response(JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "qwen2.5-coder-32b",
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: err.message, type: "server_error" }
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
