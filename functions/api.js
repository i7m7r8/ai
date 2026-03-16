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
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json", ...cors }
    });
  }

  try {
    let body = {};
    try { body = await request.json(); } catch (e) {}

    const messages = (body.messages || [{ role: "user", content: "Hello" }])
      .map(m => ({
        role: ["system","user","assistant"].includes(m.role) ? m.role : "user",
        content: String(m.content || "")
      }));

    const ai = await env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      { messages, max_tokens: 8192 }
    );

    return new Response(JSON.stringify({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "llama-3.3-70b",
      choices: [{
        index: 0,
        message: { role: "assistant", content: ai.response || "" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), { headers: { "Content-Type": "application/json", ...cors } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...cors }
    });
  }
}
