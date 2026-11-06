const MODEL = Bun.env.GEMINI_MODEL || "gemini-3.8-flash";
const ALLOWED_ORIGIN = Bun.env.ALLOWED_ORIGIN || "https://gxr772432-oss.github.io";
const MAX_BODY = 16_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;
const requests = new Map<string, { count: number; reset: number }>();

const headers = (origin: string | null) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Cache-Control": "no-store",
});

function json(data: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(Bun.env.PORT || 3000),
  async fetch(req) {
    const origin = req.headers.get("origin");
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      if (origin && origin !== ALLOWED_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: headers(origin) });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return json({ ok: true, service: "CHA OS AI", model: MODEL }, 200, origin);
    }

    if (url.pathname !== "/api/chat" || req.method !== "POST") {
      return json({ error: "المسار غير موجود" }, 404, origin);
    }

    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403, origin);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const now = Date.now();
    const bucket = requests.get(ip);
    if (bucket && bucket.reset > now && bucket.count >= MAX_REQUESTS) {
      return json({ error: "وصلت للحد المؤقت. انتظر دقيقة وجرب مرة ثانية." }, 429, origin);
    }
    requests.set(ip, !bucket || bucket.reset <= now
      ? { count: 1, reset: now + WINDOW_MS }
      : { count: bucket.count + 1, reset: bucket.reset });

    const apiKey = Bun.env.GEMINI_API_KEY;
    if (!apiKey) return json({ error: "الخادم غير مكتمل الإعداد: مفتاح Gemini غير مضاف." }, 503, origin);

    const length = Number(req.headers.get("content-length") || 0);
    if (length > MAX_BODY) return json({ error: "الطلب كبير جداً." }, 413, origin);

    let body: { message?: string; history?: Array<{ role?: string; text?: string }> };
    try { body = await req.json(); } catch { return json({ error: "صيغة الطلب غير صحيحة." }, 400, origin); }

    const message = String(body.message || "").trim();
    if (!message || message.length > 5000) return json({ error: "اكتب رسالة من 1 إلى 5000 حرف." }, 400, origin);

    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    const transcript = history
      .filter(x => (x.role === "user" || x.role === "assistant") && typeof x.text === "string")
      .map(x => (x.role === "user" ? "المستخدم" : "كوفي حجي علي") + ": " + String(x.text).slice(0, 2500))
      .join("\n");
    const input = (transcript ? "سياق المحادثة السابقة:\n" + transcript + "\n\n" : "") + "رسالة المستخدم الحالية: " + message;

    try {
      const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          model: MODEL,
          input,
          store: false,
          system_instruction: "أنت مساعد كوفي حجي علي CHA OS، مساعد شخصي رقمي. أجب بالعربية الواضحة ويفضل اللهجة العراقية عندما يناسب. كن عملياً ودقيقاً. لا تدّع تنفيذ أفعال خارج النظام. إذا طلب المستخدم إجراءً لا تملك أداة لتنفيذه، اشرح ذلك بوضوح وقدّم الخطوة الممكنة."
        }),
        signal: AbortSignal.timeout(45_000),
      });

      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const message = upstream.status === 429
          ? "انتهى الحد المؤقت لاستخدام Gemini. حاول لاحقاً."
          : upstream.status === 401 || upstream.status === 403
            ? "مفتاح Gemini غير صالح أو لا يملك صلاحية."
            : "تعذر الاتصال بخدمة الذكاء الاصطناعي حالياً.";
        return json({ error: message, providerStatus: upstream.status }, 502, origin);
      }

      const answer = typeof result.output_text === "string" ? result.output_text : "";
      if (!answer) return json({ error: "وصل رد فارغ من Gemini. حاول مرة ثانية." }, 502, origin);
      return json({ answer, model: MODEL }, 200, origin);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return json({ error: timedOut ? "تأخر الرد. حاول مرة ثانية." : "تعذر الوصول إلى Gemini." }, 502, origin);
    }
  },
});

console.log(`CHA OS backend listening on ${server.hostname}:${server.port}`);
