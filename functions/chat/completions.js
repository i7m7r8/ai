export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const url = new URL(request.url);

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (request.method === "GET") {
    return new Response(JSON.stringify({
      status: "ok",
      model: "llama-4-scout"
    }), {
      headers: { "Content-Type": "application/json", ...cors }
    });
  }

  if (url.pathname.includes("/models") || url.pathname.includes("/tags")) {
    return new Response(JSON.stringify({
      object: "list",
      data: [{
        id: "llama-4-scout",
        object: "model",
        created: 1700000000,
        owned_by: "meta"
      }],
      models: [{
        name: "llama-4-scout",
        model: "llama-4-scout"
      }]
    }), {
      headers: { "Content-Type": "application/json", ...cors }
    });
  }

  try {
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const messages = (body.messages || [{
      role: "user",
      content: body.prompt || "Hello"
    }]).map(m => ({
      role: ["system", "user", "assistant"].includes(m.role) ? m.role : "user",
      content: Array.isArray(m.content)
        ? m.content.map(p => p.text || p).join(" ")
        : String(m.content || "")
    }));

    const ai = await env.AI.run(
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      { messages, max_tokens: 8192 }
    );

    const content = ai.response || "";

    if (url.pathname.includes("/api/chat")) {
      return new Response(JSON.stringify({
        model: "llama-4-scout",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content },
        done: true,
        done_reason: "stop"
      }), {
        headers: { "Content-Type": "application/json", ...cors }
      });
    }

    return new Response(JSON.stringify({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "llama-4-scout",
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), {
      headers: { "Content-Type": "application/json", ...cors }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: { message: err.message, type: "server_error" }
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors }
    });
  }
}
