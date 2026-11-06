const MODEL = Bun.env.GEMINI_MODEL || "gemini-3.8-flash";
const ALLOWED_ORIGIN = Bun.env.ALLOWED_ORIGIN || "https://gxr772432-oss.github.io";
const MAX_BODY = 16_000;
const WINDOW_MS = 60_000;
const MAX_CHAT_REQUESTS = 12;
const MAX_LOGIN_REQUESTS = 5;
const SESSION_MS = 12 * 60 * 60 * 1000;
const chatRequests = new Map<string, { count: number; reset: number }>();
const loginRequests = new Map<string, { count: number; reset: number }>();
const sessions = new Map<string, number>();

const headers = (origin: string | null) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(data: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(data), { status, headers: headers(origin) });
}

function allowed(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || origin === ALLOWED_ORIGIN;
}

function takeLimit(map: Map<string, { count: number; reset: number }>, key: string, max: number) {
  const now = Date.now();
  const bucket = map.get(key);
  if (!bucket || bucket.reset <= now) {
    map.set(key, { count: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

async function sameSecret(candidate: string, expected: string) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(candidate)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(Bun.env.PORT || 3000),
  async fetch(req) {
    const origin = req.headers.get("origin");
    const url = new URL(req.url);
    if (!allowed(req)) return json({ error: "Origin not allowed" }, 403, origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers(origin) });
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return json({ ok: true, service: "CHA OS AI", model: MODEL, authentication: "enabled" }, 200, origin);
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (!takeLimit(loginRequests, ip, MAX_LOGIN_REQUESTS)) {
        return json({ error: "محاولات دخول كثيرة. انتظر دقيقة ثم حاول." }, 429, origin);
      }
      const password = Bun.env.CHA_LOGIN_PASSWORD;
      if (!password || password.length < 14) {
        return json({ error: "إعداد كلمة مرور الدخول غير مكتمل. أضف CHA_LOGIN_PASSWORD بطول 14 حرفاً على الأقل في إعدادات الخادم." }, 503, origin);
      }
      const length = Number(req.headers.get("content-length") || 0);
      if (length > 2_000) return json({ error: "الطلب كبير جداً." }, 413, origin);
      let body: { password?: string };
      try { body = await req.json(); } catch { return json({ error: "صيغة الطلب غير صحيحة." }, 400, origin); }
      const candidate = typeof body.password === "string" ? body.password : "";
      if (!candidate || candidate.length > 256 || !(await sameSecret(candidate, password))) {
        return json({ error: "كلمة المرور غير صحيحة." }, 401, origin);
      }
      const token = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
      sessions.set(token, Date.now() + SESSION_MS);
      return json({ token, expiresIn: SESSION_MS }, 200, origin);
    }

    if (url.pathname !== "/api/chat" || req.method !== "POST") {
      return json({ error: "المسار غير موجود" }, 404, origin);
    }

    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const expiresAt = sessions.get(token);
    if (!token || !expiresAt || expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return json({ error: "انتهت جلسة الدخول. سجّل دخولك من جديد." }, 401, origin);
    }

    const ip = clientIp(req);
    if (!takeLimit(chatRequests, ip, MAX_CHAT_REQUESTS)) {
      return json({ error: "وصلت للحد المؤقت. انتظر دقيقة وجرب مرة ثانية." }, 429, origin);
    }

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
