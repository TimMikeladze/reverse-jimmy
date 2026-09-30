# chatjimmy.ai protocol (reversed via Chrome DevTools, 2026-09-30)

No auth, no cookies. Base `https://chatjimmy.ai`.

- `GET /api/health` → `{status, backend, backendDetails: {queue_size}, ...}`
- `GET /api/models` → OpenAI-style `{object:"list", data:[{id:"llama3.1-8B", ...}]}`
- `POST /api/chat` JSON:
  ```json
  {
  	"messages": [{ "role": "user", "content": "hi" }],
  	"chatOptions": { "selectedModel": "llama3.1-8B", "systemPrompt": "", "topK": 8 },
  	"attachment": null
  }
  ```
  Response: `text/plain` stream of raw tokens, terminated by
  `<|stats|>{...json...}<|/stats|>` (tokens, rates, ttft, done_reason).

## Wrapper design

- `JimmyClient`: `chat()`, `stream()`, `models()`, `health()`, `batch()`.
- Optional limiter: `maxConcurrent` + `minIntervalMs` (queue, FIFO).
- Optional retries with exponential backoff on 429/5xx/network errors.
- `batch(prompts, {concurrency})` runs through the limiter, returns settled results in order.
- Identity: rotating browser UA pool (or custom string/array/fn), browser-like Origin/Referer, optional proxy rotation + jitter, `credentials: "omit"`. Limiter slot held for full stream duration.
