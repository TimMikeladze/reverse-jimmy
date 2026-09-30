# reverse-jimmy

Minimal TypeScript client for [chatjimmy.ai](https://chatjimmy.ai) (llama3.1-8B). No auth needed. Protocol notes: [docs/protocol.md](docs/protocol.md).

## Installation

```bash
bun add reverse-jimmy
```

## Usage

```typescript
import { JimmyClient } from 'reverse-jimmy';

const jimmy = new JimmyClient({
	maxConcurrent: 2, // optional: cap in-flight requests
	minIntervalMs: 250, // optional: space out request starts
	retries: 2, // optional: retry 429/5xx/network errors with backoff
});

const { text, stats } = await jimmy.chat('Say hi', { systemPrompt: 'Be brief', topK: 8 });

for await (const chunk of jimmy.stream('Name 3 colors')) process.stdout.write(chunk);

// Batch: runs through the limiter, results in input order (Promise.allSettled shape)
const results = await jimmy.batch(['2+2?', 'Capital of France?']);

await jimmy.models(); // ["llama3.1-8B"]
await jimmy.health();
```

Multi-turn: pass `Message[]` (`{ role, content }`) instead of a string.

## Identity & obfuscation

By default each request gets a random browser `User-Agent` from `DEFAULT_USER_AGENTS`, browser-like `Accept`/`Origin`/`Referer` headers, and no cookies (`credentials: "omit"`).

```typescript
new JimmyClient({
	userAgent: ['UA one', 'UA two'], // string | string[] (random per request) | () => string
	proxy: ['http://p1:8080', 'http://p2:8080'], // same rotation; Bun `fetch` proxy option
	jitterMs: 400, // random 0-400ms delay before each request
	browserHeaders: false, // drop Accept/Origin/Referer
	headers: { 'Accept-Language': 'de-DE' }, // merged last, overrides everything
	timeoutMs: 15_000, // per attempt, until headers arrive
});
```

On Node, proxies need a custom `fetch` (e.g. undici `ProxyAgent`) via the `fetch` option.

## Contributing

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines.

## License

MIT
