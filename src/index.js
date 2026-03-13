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
        {
          messages,
          max_tokens: 8192,
          stream: false
        }
      );

      // Fixed response format — Maid needs exact OpenAI spec
      return new Response(JSON.stringify({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "qwen2.5-coder-32b",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: response.response ?? ""
          },
          delta: {
            role: "assistant",
            content: response.response ?? ""
          },
          finish_reason: "stop",
          logprobs: null
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        },
        system_fingerprint: null
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        id: "error",
        error: {
          message: err.message,
          type: "server_error"
        }
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
