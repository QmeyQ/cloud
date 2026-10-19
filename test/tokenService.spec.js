// getAccessToken：token 获取、isolate 缓存、并发去重、失败重试与备用网关
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFetchRouter } from './helpers/fetchRouter.js';
import { getAccessToken, getWorkingGateway, resetTokenCache } from '../src/agc/tokenService.js';

const GW = 'https://connect-api.cloud.huawei.com/';
const BACKUP_GW = 'https://connect-api.cloud.huawei.com.cn/';
const TOKEN_URL = `${GW}api/oauth2/v1/token`;
const BACKUP_TOKEN_URL = `${BACKUP_GW}api/oauth2/v1/token`;

const CRED = {
	projectId: 'proj456',
	region: 'CN',
	developerId: 'dev123',
	clientId: 'cid-123',
	clientSecret: 'sec-456',
};

let stub;

// 注册一次 token mock 并捕获出站请求
function mockTokenOnce(accessToken = 'tok-abc', expiresIn = 3600, capture = {}) {
	stub.post(TOKEN_URL, async (req) => {
		capture.url = req.url;
		capture.body = JSON.parse(await req.text());
		capture.headers = req.headers;
		return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	});
	return capture;
}

function tokenResponse(accessToken, expiresIn) {
	return () =>
		new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
}

beforeEach(() => {
	resetTokenCache();
	stub = installFetchRouter();
});

afterEach(() => {
	stub.assertNoPending();
	stub.restore();
});

describe('getAccessToken 成功路径', () => {
	it('POST token 端点换取 access_token，请求体与请求头符合 SDK 约定', async () => {
		const cap = mockTokenOnce('tok-abc', 3600);
		const token = await getAccessToken(CRED);
		expect(token).toBe('tok-abc');
		expect(cap.url).toBe(TOKEN_URL);
		expect(cap.body).toEqual({
			grant_type: 'client_credentials',
			client_id: 'cid-123',
			client_secret: 'sec-456',
		});
		expect(cap.headers.get('algorithm_type')).toBe('1');
		expect(cap.headers.get('Content-Type')).toBe('application/json');
	});
});

describe('token 缓存行为', () => {
	it('两次顺序调用只发一次出站请求', async () => {
		let calls = 0;
		stub.post(TOKEN_URL, () => {
			calls++;
			return new Response(JSON.stringify({ access_token: 't1', expires_in: 3600 }), { status: 200 });
		});
		const first = await getAccessToken(CRED);
		const second = await getAccessToken(CRED);
		expect(calls).toBe(1);
		expect(second).toBe(first);
		expect(second).toBe('t1');
	});

	it('并发调用共享同一次刷新（去重）', async () => {
		let calls = 0;
		stub.post(TOKEN_URL, () => {
			calls++;
			return new Response(JSON.stringify({ access_token: 't1', expires_in: 3600 }), { status: 200 });
		});
		const [a, b] = await Promise.all([getAccessToken(CRED), getAccessToken(CRED)]);
		expect(calls).toBe(1);
		expect(a).toBe('t1');
		expect(b).toBe('t1');
	});

	it('expires_in 缺省按 3600 秒缓存', async () => {
		let calls = 0;
		stub.post(TOKEN_URL, () => {
			calls++;
			return new Response(JSON.stringify({ access_token: 't2' }), { status: 200 });
		});
		await getAccessToken(CRED);
		const again = await getAccessToken(CRED);
		expect(calls).toBe(1);
		expect(again).toBe('t2');
	});

	it('有效期不足 120 秒时提前失效并重新请求', async () => {
		let calls = 0;
		const handler = () => {
			calls++;
			return new Response(JSON.stringify({ access_token: 't3', expires_in: 1 }), { status: 200 });
		};
		// 注册可消费两次的路由，供两次刷新分别使用
		stub.postTimes(TOKEN_URL, handler, 2);
		const first = await getAccessToken(CRED);
		const second = await getAccessToken(CRED);
		expect(calls).toBe(2);
		expect(first).toBe('t3');
		expect(second).toBe('t3');
	});

	it('resetTokenCache 后强制重新请求', async () => {
		let calls = 0;
		const handler = () => {
			calls++;
			return new Response(JSON.stringify({ access_token: 't4', expires_in: 3600 }), { status: 200 });
		};
		stub.postTimes(TOKEN_URL, handler, 2);
		await getAccessToken(CRED);
		resetTokenCache();
		const again = await getAccessToken(CRED);
		expect(calls).toBe(2);
		expect(again).toBe('t4');
	});
});

describe('token 失败路径', () => {
	it('401 响应抛 12002，detail 为响应体序列化', async () => {
		stub.post(
			TOKEN_URL,
			() => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })
		);
		let err;
		try {
			await getAccessToken(CRED);
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12002');
		expect(err.message).toBe('get access token failed');
		expect(err.detail).toBe(`status=401 body=${JSON.stringify({ error: 'invalid_client' })}`);
	});

	it('200 但缺少 access_token 抛 12002', async () => {
		stub.post(
			TOKEN_URL,
			() => new Response(JSON.stringify({ foo: 1 }), { status: 200 })
		);
		await expect(getAccessToken(CRED)).rejects.toMatchObject({ code: '12002' });
	});

	it('200 但响应体非法 JSON 抛 12002（detail 携带状态码与原文）', async () => {
		stub.post(
			TOKEN_URL,
			() => new Response('not-json', { status: 200 })
		);
		let err;
		try {
			await getAccessToken(CRED);
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12002');
		expect(err.detail).toBe('status=200 body=not-json');
	});

	it('主网关网络异常时自动改用备用网关', async () => {
		// 主网关不注册 mock（未匹配 → 网络错误），备用网关注册成功响应
		stub.post(BACKUP_TOKEN_URL, tokenResponse('backup-tok', 3600));
		const token = await getAccessToken(CRED);
		expect(token).toBe('backup-tok');
	});

	it('主备网关均失败抛 12002 并携带网络错误信息', async () => {
		let err;
		try {
			await getAccessToken(CRED);
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12002');
		expect(err.detail).toBeTruthy();
	});
});
describe('client 模式 token（客户端网关 + /agc/apigw 路径）', () => {
	const GW = 'https://connect-drcn.dbankcloud.cn/';
	const BACKUP = 'https://connect-drcn.hispace.hicloud.com/';
	const CLIENT_TOKEN_URL = `${GW}agc/apigw/oauth2/v1/token`;
	const CLIENT_BACKUP_URL = `${BACKUP}agc/apigw/oauth2/v1/token`;

	const CLIENT_CRED = {
		mode: 'client',
		clientId: 'cid-789',
		clientSecret: 'sec-012',
		region: 'CN',
		gateway: { url: GW, backup: BACKUP },
	};

	it('请求客户端网关 token 路径，不携带服务端公共头', async () => {
		const capture = {};
		stub.post(CLIENT_TOKEN_URL, async (req) => {
			capture.url = req.url;
			capture.body = JSON.parse(await req.text());
			capture.headers = req.headers;
			return new Response(JSON.stringify({ access_token: 'ctok', expires_in: 100000 }), { status: 200 });
		});
		const token = await getAccessToken(CLIENT_CRED);
		expect(token).toBe('ctok');
		expect(capture.url).toBe(CLIENT_TOKEN_URL);
		expect(capture.body).toEqual({ grant_type: 'client_credentials', client_id: 'cid-789', client_secret: 'sec-012' });
		expect(capture.headers.get('algorithm_type')).toBe('1');
		expect(capture.headers.get('serverSdkName')).toBeNull();
	});

	it('主网关网络异常时改用候选回退网关', async () => {
		// 主网关与 SG 均不注册 mock（网络错误），RU 候选注册成功响应
		stub.post('https://connect-drru.hispace.dbankcloud.ru/agc/apigw/oauth2/v1/token', tokenResponse('ru-tok', 3600));
		const token = await getAccessToken(CLIENT_CRED);
		expect(token).toBe('ru-tok');
	});

	it('主网关返回 501 HTML 拦截页时自动切换候选网关（Cloudflare 出网被拦场景）', async () => {
		stub.post(CLIENT_TOKEN_URL, () => new Response('<html>invalid request</html>', { status: 501, headers: { 'Content-Type': 'text/html' } }));
		const sgUrl = 'https://connect-dra.dbankcloud.cn/agc/apigw/oauth2/v1/token';
		const capture = {};
		stub.post(sgUrl, async (req) => {
			capture.url = req.url;
			return new Response(JSON.stringify({ access_token: 'sg-tok', expires_in: 3600 }), { status: 200 });
		});
		const token = await getAccessToken(CLIENT_CRED);
		expect(token).toBe('sg-tok');
		expect(capture.url).toBe(sgUrl);
	});

	it('候选顺序：配置网关 → SG → RU → DE → 配置备用网关', async () => {
		// 主网关不注册（网络失败）；SG/RU/DE 返回 503；配置备用网关成功
		for (const url of [
			'https://connect-dra.dbankcloud.cn/agc/apigw/oauth2/v1/token',
			'https://connect-drru.hispace.dbankcloud.ru/agc/apigw/oauth2/v1/token',
			'https://connect-dre.dbankcloud.cn/agc/apigw/oauth2/v1/token',
		]) {
			stub.post(url, () => new Response('unavailable', { status: 503 }));
		}
		stub.post(CLIENT_BACKUP_URL, tokenResponse('bk-tok', 3600));
		const token = await getAccessToken(CLIENT_CRED);
		expect(token).toBe('bk-tok');
	});

	it('凭据无网关时直接从 SG 候选开始', async () => {
		const cred = { ...CLIENT_CRED, gateway: null };
		const capture = {};
		stub.post('https://connect-dra.dbankcloud.cn/agc/apigw/oauth2/v1/token', async (req) => {
			capture.url = req.url;
			return new Response(JSON.stringify({ access_token: 'st-tok', expires_in: 3600 }), { status: 200 });
		});
		await getAccessToken(cred);
		expect(capture.url).toBe('https://connect-dra.dbankcloud.cn/agc/apigw/oauth2/v1/token');
	});

	it('全部候选失败时抛 12002，detail 携带最后一个网关现场', async () => {
		let err;
		try {
			await getAccessToken(CLIENT_CRED);
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12002');
		expect(err.detail).toContain('gateway=');
	});

	it('getWorkingGateway 返回 token 实际生效的网关', async () => {
		stub.post(CLIENT_TOKEN_URL, () => new Response('<html>blocked</html>', { status: 501 }));
		stub.post('https://connect-dra.dbankcloud.cn/agc/apigw/oauth2/v1/token', tokenResponse('sg2-tok', 3600));
		await getAccessToken(CLIENT_CRED);
		expect(await getWorkingGateway(CLIENT_CRED)).toBe('https://connect-dra.dbankcloud.cn/');
	});

	it('getWorkingGateway 服务端模式返回区域网关', async () => {
		expect(await getWorkingGateway(CRED)).toBe('https://connect-api.cloud.huawei.com/');
	});
});
