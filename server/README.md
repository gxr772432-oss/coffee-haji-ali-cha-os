# CHA OS AI backend

This is the private server component for the GitHub Pages frontend.

## Deploy (Railway / Bun)

1. Create a Railway service from this repository and set the service root directory to `server`.
2. Set these server variables in Railway (never in GitHub files):
   - `GEMINI_API_KEY` = your newly created Gemini API key
   - `ALLOWED_ORIGIN` = `https://gxr772432-oss.github.io`
   - Optional: `GEMINI_MODEL` = `gemini-3.8-flash`
3. Configure the service start command as `bun run index.ts` (Railway's Bun runtime).
4. After deploy, verify `https://YOUR-SERVICE-DOMAIN/health` returns `{"ok":true,...}`.
5. Set the deployed service base URL in the repository's `config.js` as `apiBaseUrl`, then commit.

## Endpoints

- `GET /health` — health check (does not expose secrets).
- `POST /api/chat` — JSON body: `{"message":"...","history":[{"role":"user|assistant","text":"..."}]}`.

The server calls Google's Gemini Interactions API with `store:false`; the API key is read only from the server environment. Requests are limited to 12 per IP per minute and 5,000 characters per message. This in-memory rate limit resets when the service restarts and is not a substitute for user authentication. Do not use this public endpoint for sensitive data until proper sign-in/access control is added.

## Cost and privacy

Gemini usage is subject to the limits and terms of the Google AI Studio project. Free-tier availability and quotas can change. The API key must remain a server-side secret. Never commit `.env` files or paste keys into chat.
