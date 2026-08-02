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
    const { system, messages, useSearch } = req.body || {};

    // Convert our Anthropic-shaped { role, content } messages into
    // Gemini's { role, parts: [...] } format. Gemini uses "model"
    // instead of "assistant" for the AI's turns. A message can also carry
    // an "attachment" (a PDF or image sent as inline base64 data) — when
    // present, it becomes its own part alongside the text, so Gemini reads
    // the actual document/image natively rather than relying on any
    // client-side text extraction.
    const contents = (Array.isArray(messages) ? messages : []).map((m) => {
      const parts = [];
      if (m.attachment && m.attachment.mimeType && m.attachment.data) {
        parts.push({ inline_data: { mime_type: m.attachment.mimeType, data: m.attachment.data } });
      }
      parts.push({ text: m.content });
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

    const baseConfig = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      // Real internet access: google_search lets Gemini search and cite live
      // results; url_context lets it directly fetch and read a specific page
      // (e.g. a link the person pastes in). Google's docs confirm these two
      // combine fine together. Both are opt-in PER REQUEST (the person taps
      // the search toggle) rather than always-on, because on the free tier
      // combining tools with generateContent appears to route requests
      // through a much stricter daily quota (as low as 20/day instead of
      // ~1500/day for plain requests) — better to spend that budget only
      // when actually asked for.
      ...(useSearch === true ? { tools: [{ google_search: {} }, { url_context: {} }] } : {}),
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

    // If there's no answer text, capture *why* instead of silently retrying
    // (a second call would double the request count against an already
    // tight daily quota). The person can hit Retry manually if they want
    // another attempt — that's a deliberate choice, not an automatic one.
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

    // Pull real citations out of two places: search grounding (when Gemini
    // used web search) and url_context (when it fetched a specific link the
    // person pasted in). Deduplicated by URL.
    const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const urlContextEntries = data?.candidates?.[0]?.urlContextMetadata?.urlMetadata || [];
    const seen = new Set();
    const sources = [];
    for (const c of groundingChunks) {
      const uri = c?.web?.uri;
      const title = c?.web?.title || uri;
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        sources.push({ title, uri });
      }
    }
    for (const u of urlContextEntries) {
      const uri = u?.retrievedUrl;
      const ok2 = u?.urlRetrievalStatus === "URL_RETRIEVAL_STATUS_SUCCESS";
      if (uri && ok2 && !seen.has(uri)) {
        seen.add(uri);
        sources.push({ title: uri, uri });
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
