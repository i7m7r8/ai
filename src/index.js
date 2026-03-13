export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    // OpenAI models list
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "qwen2.5-coder-32b", object: "model", created: 1700000000, owned_by: "cloudflare" }]
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // Ollama models list
    if (url.pathname === "/api/tags") {
      return new Response(JSON.stringify({
        models: [{ name: "qwen2.5-coder-32b", model: "qwen2.5-coder-32b", modified_at: "2025-01-01T00:00:00Z", size: 1000000000 }]
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    try {
      let messages = [];

      // Handle both Ollama (/api/chat) and OpenAI (/v1/chat/completions) formats
      const body = await request.json();
      messages = body.messages || [{ role: "user", content: body.prompt || "Hello" }];

      const response = await env.AI.run(
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        { messages, max_tokens: 8192, stream: false }
      );

      const content = response.response ?? "";

      // Ollama format response
      if (url.pathname === "/api/chat" || url.pathname === "/api/generate") {
        return new Response(JSON.stringify({
          model: "qwen2.5-coder-32b",
          created_at: new Date().toISOString(),
          message: { role: "assistant", content },
          done: true,
          done_reason: "stop"
        }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }

      // OpenAI format response
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
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message, type: "server_error" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};
