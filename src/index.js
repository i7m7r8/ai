export default {
  async fetch(request, env) {

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
      });
    }

    try {
      const body = await request.json();
      const messages = body.messages || [
        { role: "user", content: body.prompt || "Hello" }
      ];

      const response = await env.AI.run(
        "@cf/qwen/qwen2.5-coder-7b-instruct",
        {
          messages,
          max_tokens: 2048,
          stream: false
        }
      );

      // Return OpenAI-compatible format so any app works
      return new Response(JSON.stringify({
        id: "chatcmpl-cf",
        object: "chat.completion",
        choices: [{
          message: {
            role: "assistant",
            content: response.response
          },
          finish_reason: "stop",
          index: 0
        }],
        model: "qwen2.5-coder-7b"
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message
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
