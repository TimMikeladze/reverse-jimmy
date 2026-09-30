import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_USER_AGENTS,
	JimmyClient,
	JimmyError,
	Limiter,
	parseResponse,
	pick,
} from '../src/index';

const STATS = '<|stats|>{"done":true,"total_tokens":3}<|/stats|>';

function fakeFetch(chunks: string[], status = 200) {
	const calls: RequestInit[] = [];
	const fn = (async (_url: string, init: RequestInit) => {
		calls.push(init);
		const body = new ReadableStream({
			start(c) {
				for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
				c.close();
			},
		});
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe('parseResponse', () => {
	test('splits text and stats', () => {
		expect(parseResponse(`hi${STATS}`)).toEqual({
			text: 'hi',
			stats: { done: true, total_tokens: 3 } as never,
		});
	});
	test('no stats', () => {
		expect(parseResponse('hi').stats).toBeNull();
	});
});

describe('JimmyClient', () => {
	test('chat sends expected body and strips stats split across chunks', async () => {
		const { fn, calls } = fakeFetch(['Hel', 'lo<|st', 'ats|>{"done":true}<|/stats|>']);
		const r = await new JimmyClient({ fetch: fn }).chat('yo', { systemPrompt: 's' });
		expect(r.text).toBe('Hello');
		expect(r.stats?.done).toBe(true);
		expect(JSON.parse(calls[0]!.body as string)).toEqual({
			messages: [{ role: 'user', content: 'yo' }],
			chatOptions: { selectedModel: 'llama3.1-8B', systemPrompt: 's', topK: 8 },
			attachment: null,
		});
	});

	test('retries on 5xx then throws', async () => {
		const { fn, calls } = fakeFetch(['err'], 503);
		const c = new JimmyClient({ fetch: fn, retries: 2, retryBaseMs: 1 });
		await expect(c.chat('x')).rejects.toThrow('HTTP 503');
		expect(calls.length).toBe(3);
	});

	test('batch preserves order', async () => {
		const fn = (async (_u: string, init: RequestInit) => {
			const p = JSON.parse(init.body as string).messages[0].content;
			return new Response(p + STATS);
		}) as unknown as typeof fetch;
		const res = await new JimmyClient({ fetch: fn, maxConcurrent: 2 }).batch(['a', 'b', 'c']);
		expect(res.map((r) => r.status === 'fulfilled' && r.value.text)).toEqual(['a', 'b', 'c']);
	});
});

describe('Limiter', () => {
	test('caps concurrency', async () => {
		const l = new Limiter(2);
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				l.run(async () => {
					peak = Math.max(peak, ++active);
					await Bun.sleep(5);
					active--;
				}),
			),
		);
		expect(peak).toBe(2);
	});

	test('spaces request starts', async () => {
		const l = new Limiter(Infinity, 30);
		const t0 = Date.now();
		await Promise.all([1, 2, 3].map(() => l.run(async () => {})));
		expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
	});
});

type Call = {
	url: string;
	init: RequestInit & { proxy?: string; headers: Record<string, string> };
};
function recorder(
	respond: (n: number) => Response | Promise<Response> = () => new Response(`ok${STATS}`),
) {
	const calls: Call[] = [];
	const fn = (async (url: string, init: Call['init']) => {
		calls.push({ url, init });
		return respond(calls.length);
	}) as unknown as typeof fetch;
	return { fn, calls };
}

describe('identity and headers', () => {
	test('default: browser UA from pool, browser headers, no cookies', async () => {
		const { fn, calls } = recorder();
		await new JimmyClient({ fetch: fn }).chat('x');
		const { headers, credentials } = calls[0]!.init;
		expect(DEFAULT_USER_AGENTS).toContain(headers['User-Agent']!);
		expect(headers.Origin).toBe('https://chatjimmy.ai');
		expect(headers.Referer).toBe('https://chatjimmy.ai/');
		expect(credentials).toBe('omit');
	});

	test('userAgent function is called per request; custom headers override', async () => {
		const { fn, calls } = recorder();
		let n = 0;
		const c = new JimmyClient({
			fetch: fn,
			userAgent: () => `ua-${++n}`,
			browserHeaders: false,
			headers: { 'Accept-Language': 'de' },
		});
		await c.chat('a');
		await c.chat('b');
		expect(calls.map((c) => c.init.headers['User-Agent'])).toEqual(['ua-1', 'ua-2']);
		expect(calls[0]!.init.headers.Origin).toBeUndefined();
		expect(calls[0]!.init.headers['Accept-Language']).toBe('de');
	});

	test('proxy picked from pool and passed to fetch', async () => {
		const { fn, calls } = recorder();
		await new JimmyClient({ fetch: fn, proxy: ['http://p1:8080'] }).chat('x');
		expect(calls[0]!.init.proxy).toBe('http://p1:8080');
	});

	test('pick handles value, array, function', () => {
		expect(pick('a')).toBe('a');
		expect(pick(['b'])).toBe('b');
		expect(pick(() => 'c')).toBe('c');
	});
});

describe('resilience', () => {
	test('honors Retry-After then succeeds', async () => {
		const { fn, calls } = recorder((n) =>
			n === 1
				? new Response('slow', { status: 429, headers: { 'retry-after': '0.01' } })
				: new Response(`ok${STATS}`),
		);
		const r = await new JimmyClient({ fetch: fn, retries: 1, retryBaseMs: 10_000 }).chat('x');
		expect(r.text).toBe('ok');
		expect(calls.length).toBe(2);
	});

	test('does not retry 4xx', async () => {
		const { fn, calls } = recorder(() => new Response('bad', { status: 400 }));
		await expect(new JimmyClient({ fetch: fn, retries: 3 }).chat('x')).rejects.toBeInstanceOf(
			JimmyError,
		);
		expect(calls.length).toBe(1);
	});

	test('timeout aborts hung request and retries', async () => {
		let n = 0;
		const fn = ((_u: string, init: RequestInit) => {
			if (++n === 1)
				return new Promise((_, rej) =>
					init.signal!.addEventListener('abort', () => rej(init.signal!.reason)),
				);
			return Promise.resolve(new Response(`ok${STATS}`));
		}) as unknown as typeof fetch;
		const r = await new JimmyClient({ fetch: fn, timeoutMs: 20, retries: 1, retryBaseMs: 1 }).chat(
			'x',
		);
		expect(r.text).toBe('ok');
	});

	test('breaking out of a stream releases the concurrency slot', async () => {
		const { fn } = recorder(() => new Response(`a much longer response body here${STATS}`));
		const c = new JimmyClient({ fetch: fn, maxConcurrent: 1 });
		for await (const _ of c.stream('x')) break;
		const r = await c.chat('y'); // would hang if slot leaked
		expect(r.text).toContain('longer');
	});
});

describe('Limiter ordering', () => {
	test('new caller cannot jump ahead of queued waiters', async () => {
		const l = new Limiter(1);
		const order: number[] = [];
		const release = await l.acquire();
		const a = l.run(async () => void order.push(1));
		release();
		const b = l.run(async () => void order.push(2));
		await Promise.all([a, b]);
		expect(order).toEqual([1, 2]);
	});
});
