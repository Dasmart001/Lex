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

  async function callGemini(config) {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(config),
      }
    );
    const data = await geminiResponse.json();
    return { ok: geminiResponse.ok, status: geminiResponse.status, data };
  }

  try {
    const { system, messages } = req.body || {};

    const contents = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const baseConfig = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(process.env.ENABLE_WEB_SEARCH === "true" ? { tools: [{ google_search: {} }] } : {}),
    };

    let { ok, status, data } = await callGemini({
      ...baseConfig,
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
      },
    });

    if (!ok) {
      const message = data?.error?.message || "Gemini API request failed.";
      return res.status(status).json({
        content: [{ type: "text", text: "" }],
        error: message,
      });
    }

    let parts = data?.candidates?.[0]?.content?.parts || [];
    let thinking = parts.filter((p) => p.thought).map((p) => p.text || "").join("\n").trim();
    let text = parts.filter((p) => !p.thought).map((p) => p.text || "").join("\n").trim();

    let diagnostic = "";
    if (!text) {
      const finishReason = data?.candidates?.[0]?.finishReason;
      const blockReason = data?.promptFeedback?.blockReason;
      diagnostic = blockReason
        ? `Blocked by Gemini: ${blockReason}`
        : finishReason
        ? `Gemini stopped with no output (reason: ${finishReason}). Try Retry, or ask a shorter question.`
        : "Gemini returned an empty response for an unknown reason.";
    }

    const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const seen = new Set();
    const sources = [];
    for (const c of chunks) {
      const uri = c?.web?.uri;
      const title = c?.web?.title || uri;
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        sources.push({ title, uri });
      }
    }

    return res.status(200).json({
      content: [{ type: "text", text }],
      thinking,
      sources,
      error: diagnostic || undefined,
    });
  } catch (err) {
    return res.status(500).json({
      content: [{ type: "text", text: "" }],
      error: String(err),
    });
  }
}
