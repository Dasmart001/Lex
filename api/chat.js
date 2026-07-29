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

    // Convert our Anthropic-shaped { role, content } messages into
    // Gemini's { role, parts: [{ text }] } format. Gemini uses "model"
    // instead of "assistant" for the AI's turns.
    const contents = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const baseConfig = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      // Real web grounding: lets Gemini search Google and cite live sources
      // instead of answering purely from training data. This is what makes
      // LexAI's research genuinely checkable rather than just plausible.
      tools: [{ google_search: {} }],
    };

    // First attempt: with thinking enabled, generous token budget so
    // reasoning doesn't crowd out the actual answer.
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
    let groundingSource = data;

    // Safety net: if thinking consumed the whole token budget and left no
    // actual answer, retry once with thinking off so the user still gets
    // a real response instead of an empty one.
    let diagnostic = "";
    if (!text) {
      const retry = await callGemini({
        ...baseConfig,
        generationConfig: { maxOutputTokens: 8192 },
      });
      if (retry.ok) {
        const retryParts = retry.data?.candidates?.[0]?.content?.parts || [];
        text = retryParts.map((p) => p.text || "").join("\n").trim();
        thinking = "";
        groundingSource = retry.data;
        if (!text) {
          // Still nothing — capture *why* so we can actually see the real
          // reason instead of guessing (blocked prompt, safety filter,
          // hit max tokens with no output, etc).
          const finishReason = retry.data?.candidates?.[0]?.finishReason;
          const blockReason = retry.data?.promptFeedback?.blockReason;
          diagnostic = blockReason
            ? `Blocked by Gemini: ${blockReason}`
            : finishReason
            ? `Gemini stopped with no output (reason: ${finishReason})`
            : "Gemini returned an empty response for an unknown reason.";
        }
      } else {
        diagnostic = retry.data?.error?.message || "Retry request to Gemini failed.";
      }
    }

    // Pull real citations out of the grounding metadata, when Gemini
    // actually used web search for this answer. Deduplicated by URL.
    const chunks = groundingSource?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
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

    // Shape the response the same way the frontend already expects,
    // so index.html needed zero changes beyond the URL it calls.
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
