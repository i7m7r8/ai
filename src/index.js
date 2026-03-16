export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Health check
    if (request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", model: "qwen2.5-coder-32b" }), {
        headers: { "Content-Type": "application/json", ...cors }
      });
    }

    // Models list
    if (url.pathname === "/v1/models" || url.pathname === "/api/tags") {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "qwen2.5-coder-32b", object: "model", owned_by: "cloudflare" }],
        models: [{ name: "qwen2.5-coder-32b", model: "qwen2.5-coder-32b" }]
      }), { headers: { "Content-Type": "application/json", ...cors } });
    }

    // Chat
    try {
      let body = {};
      try { body = await request.json(); } catch (e) {}

      const messages = (body.messages || [{ role: "user", content: body.prompt || "Hello" }])
        .map(m => ({
          role: ["system","user","assistant"].includes(m.role) ? m.role : "user",
          content: Array.isArray(m.content)
            ? m.content.map(p => p.text || p).join(" ")
            : String(m.content || "")
        }));

      const ai = await env.AI.run(
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        { messages, max_tokens: 8192, stream: false }
      );

      const content = ai.response || "";

      // Ollama format
      if (url.pathname === "/api/chat") {
        return new Response(JSON.stringify({
          model: "qwen2.5-coder-32b",
          created_at: new Date().toISOString(),
          message: { role: "assistant", content },
          done: true,
          done_reason: "stop"
        }), { headers: { "Content-Type": "application/json", ...cors } });
      }

      // OpenAI format (default)
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
      }), { headers: { "Content-Type": "application/json", ...cors } });

    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: err.message, type: "server_error" }
      }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
    }
  }
};
