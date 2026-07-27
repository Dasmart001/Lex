// LexAI backend — proxies chat requests to Google's Gemini API.
// Deployed as a Vercel serverless function at /api/chat.
//
// Why this exists: the Gemini/Anthropic API key must never be sent to the
// browser. This function holds the key server-side (as a Vercel environment
// variable) and the frontend calls this endpoint instead of Google directly.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      content: [{ type: "text", text: "" }],
      error: "GEMINI_API_KEY is not set on the server. Add it in your Vercel project's Environment Variables.",
    });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  try {
    const { system, messages } = req.body || {};

    const contents = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            maxOutputTokens: 4096,
            thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
          },
        }),
      }
    );

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const message = data?.error?.message || "Gemini API request failed.";
      return res.status(geminiResponse.status).json({
        content: [{ type: "text", text: "" }],
        error: message,
      });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const thinking = parts.filter((p) => p.thought).map((p) => p.text || "").join("\n").trim();
    const text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n").trim();

    return res.status(200).json({
      content: [{ type: "text", text }],
      thinking,
    });
  } catch (err) {
    return res.status(500).json({
      content: [{ type: "text", text: "" }],
      error: String(err),
    });
  }
                                                      }
