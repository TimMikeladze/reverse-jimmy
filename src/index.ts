export type Role = 'system' | 'user' | 'assistant';
export interface Message {
	role: Role;
	content: string;
}

export interface JimmyStats {
	done: boolean;
	done_reason: string;
	ttft: number;
	prefill_tokens: number;
	decode_tokens: number;
	total_tokens: number;
	decode_rate: number;
	roundtrip_time: number;
	[key: string]: unknown;
}

export interface ChatOptions {
	model?: string;
	systemPrompt?: string;
	topK?: number;
	signal?: AbortSignal;
}

export interface ChatResult {
	text: string;
	stats: JimmyStats | null;
}

/** A fixed value, a pool to pick from at random per request, or a function called per request. */
export type Rotating<T> = T | T[] | (() => T);

export interface JimmyClientOptions {
	baseUrl?: string;
	/** Max in-flight requests (held until a stream finishes). Default: unlimited. */
	maxConcurrent?: number;
	/** Min delay between request starts, in ms. Default: 0. */
	minIntervalMs?: number;
	/** Random extra delay (0..jitterMs) added before each request. Default: 0. */
	jitterMs?: number;
	/** Retries on 429/5xx/network errors. Default: 0. */
	retries?: number;
	retryBaseMs?: number;
	/** Per-attempt timeout until response headers arrive, in ms. Default: none. */
	timeoutMs?: number;
	/** User-Agent. Default: random pick from DEFAULT_USER_AGENTS per request. */
	userAgent?: Rotating<string>;
	/** Proxy URL(s), passed as Bun's `fetch(..., { proxy })`. For Node, supply `fetch` with a dispatcher. */
	proxy?: Rotating<string>;
	/** Send browser-like Accept/Origin/Referer headers. Default: true. */
	browserHeaders?: boolean;
	/** Extra headers, merged last (override everything). */
	headers?: Record<string, string>;
	fetch?: typeof fetch;
}

export const DEFAULT_USER_AGENTS: string[] = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
];

const STATS_OPEN = '<|stats|>';
const STATS_CLOSE = '<|/stats|>';

export function parseResponse(raw: string): ChatResult {
	const i = raw.indexOf(STATS_OPEN);
	if (i === -1) return { text: raw, stats: null };
	const j = raw.indexOf(STATS_CLOSE, i);
	const json = raw.slice(i + STATS_OPEN.length, j === -1 ? undefined : j);
	let stats: JimmyStats | null = null;
	try {
		stats = JSON.parse(json);
	} catch {}
	return { text: raw.slice(0, i), stats };
}

export function pick<T>(v: Rotating<T>): T {
	if (typeof v === 'function') return (v as () => T)();
	if (Array.isArray(v)) return v[Math.floor(Math.random() * v.length)]!;
	return v;
}

/** FIFO limiter: caps concurrency and spaces out slot grants. */
export class Limiter {
	private active = 0;
	private next = 0;
	private queue: (() => void)[] = [];

	constructor(
		private maxConcurrent: number = Infinity,
		private minIntervalMs: number = 0,
		private jitterMs: number = 0,
	) {}

	/** Resolves with a release function once a slot is free. */
	async acquire(): Promise<() => void> {
		if (this.active < this.maxConcurrent && this.queue.length === 0) this.active++;
		// slot is handed over directly by release(), so no one can jump the queue
		else await new Promise<void>((r) => this.queue.push(r));

		const start = Math.max(Date.now(), this.next);
		this.next = start + this.minIntervalMs;
		const wait = start - Date.now() + Math.random() * this.jitterMs;
		if (wait > 0) await sleep(wait);

		let released = false;
		return () => {
			if (released) return;
			released = true;
			const waiter = this.queue.shift();
			if (waiter) waiter();
			else this.active--;
		};
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(signal.reason);
			},
			{ once: true },
		);
	});

export class JimmyClient {
	private baseUrl: string;
	private limiter: Limiter;
	private opts: JimmyClientOptions;
	private fetchFn: typeof fetch;

	constructor(opts: JimmyClientOptions = {}) {
		this.opts = opts;
		this.baseUrl = (opts.baseUrl ?? 'https://chatjimmy.ai').replace(/\/$/, '');
		this.limiter = new Limiter(opts.maxConcurrent, opts.minIntervalMs, opts.jitterMs);
		this.fetchFn = opts.fetch ?? fetch;
	}

	health(): Promise<Record<string, unknown>> {
		return this.limiter.run(() => this.request('/api/health').then((r) => r.json()));
	}

	models(): Promise<string[]> {
		return this.limiter.run(async () => {
			const body = (await (await this.request('/api/models')).json()) as { data: { id: string }[] };
			return body.data.map((m) => m.id);
		});
	}

	/** Streams text chunks; returns stats when done. Breaking early cancels the request. */
	async *stream(
		input: string | Message[],
		opts: ChatOptions = {},
	): AsyncGenerator<string, JimmyStats | null> {
		const release = await this.limiter.acquire();
		try {
			const res = await this.request('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: typeof input === 'string' ? [{ role: 'user', content: input }] : input,
					chatOptions: {
						selectedModel: opts.model ?? 'llama3.1-8B',
						systemPrompt: opts.systemPrompt ?? '',
						topK: opts.topK ?? 8,
					},
					attachment: null,
				}),
				signal: opts.signal,
			});
			if (!res.body) throw new JimmyError('Empty response body', res.status);
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buf = '';
			let emitted = 0;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (value) buf += value;
					const cut = buf.indexOf(STATS_OPEN);
					// hold back a tail that could be the start of a split stats marker
					const safe =
						cut !== -1
							? cut
							: done
								? buf.length
								: Math.max(emitted, buf.length - STATS_OPEN.length + 1);
					if (safe > emitted) {
						yield buf.slice(emitted, safe);
						emitted = safe;
					}
					if (done) return parseResponse(buf).stats;
				}
			} finally {
				reader.cancel().catch(() => {});
			}
		} finally {
			release();
		}
	}

	async chat(input: string | Message[], opts: ChatOptions = {}): Promise<ChatResult> {
		let text = '';
		const it = this.stream(input, opts);
		for (;;) {
			const r = await it.next();
			if (r.done) return { text, stats: r.value };
			text += r.value;
		}
	}

	/** Runs many prompts through the limiter; results keep input order. */
	batch(
		inputs: (string | Message[])[],
		opts: ChatOptions = {},
	): Promise<PromiseSettledResult<ChatResult>[]> {
		return Promise.allSettled(inputs.map((i) => this.chat(i, opts)));
	}

	private buildHeaders(extra?: HeadersInit): Record<string, string> {
		const o = this.opts;
		const h: Record<string, string> = {
			'User-Agent': pick(o.userAgent ?? DEFAULT_USER_AGENTS),
		};
		if (o.browserHeaders !== false) {
			Object.assign(h, {
				Accept: '*/*',
				'Accept-Language': 'en-US,en;q=0.9',
				Origin: this.baseUrl,
				Referer: `${this.baseUrl}/`,
			});
		}
		new Headers(extra).forEach((v, k) => (h[k] = v));
		return { ...h, ...o.headers };
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		const { retries = 0, retryBaseMs = 500, timeoutMs, proxy } = this.opts;
		for (let attempt = 0; ; attempt++) {
			const signals = [init.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
				(s): s is AbortSignal => !!s,
			);
			try {
				const res = await this.fetchFn(this.baseUrl + path, {
					...init,
					headers: this.buildHeaders(init.headers),
					credentials: 'omit',
					signal: signals.length ? AbortSignal.any(signals) : undefined,
					...(proxy ? { proxy: pick(proxy) } : {}),
				} as RequestInit);
				if (res.ok) return res;
				const retryable = res.status === 429 || res.status >= 500;
				const body = await res.text().catch(() => '');
				if (!retryable || attempt >= retries)
					throw new JimmyError(`HTTP ${res.status}: ${body}`, res.status);
				const retryAfter = Number(res.headers.get('retry-after'));
				if (retryAfter > 0) {
					await sleep(Math.min(retryAfter * 1000, 60_000), init.signal ?? undefined);
					continue;
				}
			} catch (e) {
				if (e instanceof JimmyError || init.signal?.aborted || attempt >= retries) throw e;
			}
			await sleep(retryBaseMs * 2 ** attempt, init.signal ?? undefined);
		}
	}
}

export class JimmyError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = 'JimmyError';
	}
}
