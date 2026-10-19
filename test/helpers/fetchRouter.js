// 轻量出站 fetch mock：按 method + URL 前缀注册路由
// 语义对齐 @cloudflare/vitest-plugin 旧版 fetchMock：
//   - 默认前缀匹配、每个路由默认消费 1 次（可用 postTimes 指定次数）
//   - 未匹配路由的请求视为网络错误（等价 disableNetConnect）
//   - assertNoPending 检查是否存在未消费的路由（等价 assertNoPendingInterceptors）
export function installFetchRouter() {
	const realFetch = globalThis.fetch;
	const routes = [];

	function register(method, prefix, handler, times = 1) {
		routes.push({ method, prefix, handler, remaining: times });
	}

	async function mockedFetch(input, init) {
		const req = input instanceof Request ? input : new Request(input, init);
		const idx = routes.findIndex(
			(r) => r.method === req.method && req.url.startsWith(r.prefix) && r.remaining > 0
		);
		if (idx === -1) {
			// 未注册路由 → 模拟网络层失败（与真实 fetch 网络错误同为 TypeError）
			throw new TypeError(`fetch failed: no mock registered for ${req.method} ${req.url}`);
		}
		const route = routes[idx];
		route.remaining -= 1;
		if (route.remaining === 0) routes.splice(idx, 1);
		return route.handler(req);
	}

	globalThis.fetch = mockedFetch;

	return {
		get: (prefix, handler) => register('GET', prefix, handler),
		post: (prefix, handler) => register('POST', prefix, handler),
		postTimes: (prefix, handler, times) => register('POST', prefix, handler, times),
		assertNoPending: () => {
			if (routes.length > 0) {
				const list = routes.map((r) => `${r.method} ${r.prefix} x${r.remaining}`).join('; ');
				throw new Error(`存在未消费的 mock 路由: ${list}`);
			}
		},
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
}