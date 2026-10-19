// Worker 入口端到端测试：路由与 CORS、请求体校验、SDK/兼容模式、错误码到 HTTP 状态映射
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFetchRouter } from './helpers/fetchRouter.js';
import worker from '../src/index.js';
import { resetTokenCache } from '../src/agc/tokenService.js';

const GW = 'https://connect-api.cloud.huawei.com/';
const TOKEN_URL = `${GW}api/oauth2/v1/token`;
const FUNC_BASE = `${GW}api/wisefunction/functions/`;
const HASH = 'peyJV23AHvGVZ6lR4mAa0'; // hashFuncId('dev123', 'proj456')

// 与 HASH 对应的凭据（developerId=dev123 / projectId=proj456）
const BASE_ENV = {
	AGC_CLIENT_ID: 'cid-123',
	AGC_CLIENT_SECRET: 'sec-456',
	AGC_PROJECT_ID: 'proj456',
	AGC_DEVELOPER_ID: 'dev123',
	AGC_REGION: 'CN',
};

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400',
};

let stub;

function mockTokenOk() {
	stub.post(
		TOKEN_URL,
		() => new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), { status: 200 })
	);
}

// 注册云函数 mock 并捕获出站请求
function mockFuncOk(reply = () => new Response('{"code":0,"result":"ok"}', { status: 200 })) {
	const capture = {};
	stub.post(FUNC_BASE, async (req) => {
		capture.url = req.url;
		capture.headers = req.headers;
		capture.body = await req.text();
		return reply();
	});
	return capture;
}

function postJson(path, body) {
	return new Request(`http://example.com${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

async function callWorker(request, env = BASE_ENV) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeEach(() => {
	resetTokenCache();
	stub = installFetchRouter();
});

afterEach(() => {
	stub.assertNoPending();
	stub.restore();
});

describe('基础路由与 CORS', () => {
	it('OPTIONS 预检返回 204 与 CORS 头', async () => {
		const res = await callWorker(new Request('http://example.com/', { method: 'OPTIONS' }));
		expect(res.status).toBe(204);
		// headers.get 大小写不敏感，避免 fromEntries 的头名小写化
		for (const [name, value] of Object.entries(CORS)) {
			expect(res.headers.get(name)).toBe(value);
		}
	});

	it('GET /health 返回 ok 并携带 CORS 头', async () => {
		const res = await callWorker(new Request('http://example.com/health'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it.each([
		['GET', '/other'],
		['POST', '/unknown'],
		['DELETE', '/'],
	])('%s %s 返回 405', async (method, path) => {
		const res = await callWorker(new Request(`http://example.com${path}`, { method }));
		expect(res.status).toBe(405);
		expect(await res.json()).toEqual({ error: 'Method Not Allowed' });
	});
});

describe('请求体校验', () => {
	it('非 JSON 请求体返回 400', async () => {
		const res = await callWorker(postJson('/', 'not-json'));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('JSON');
	});

	it('JSON 标量（非对象）且未配置默认函数返回 400', async () => {
		const res = await callWorker(postJson('/', '123'));
		expect(res.status).toBe(400);
	});

	it('对象缺少 name 字段且未配置 AGC_DEFAULT_FUNCTION_NAME 返回 400', async () => {
		const res = await callWorker(postJson('/', { k: 1 }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain('name');
	});
});

describe('SDK 模式（body 含 name）', () => {
	it('POST / 成功透传云函数响应体', async () => {
		mockTokenOk();
		const cap = mockFuncOk();
		const res = await callWorker(postJson('/', { name: 'myfunc', data: { a: 1 } }));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/json');
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await res.text()).toBe('{"code":0,"result":"ok"}');
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
		expect(cap.headers.get('Authorization')).toBe('Bearer tok-abc');
		expect(cap.body).toBe('{"a":1}');
	});

	it('POST /call 路径同样可用', async () => {
		mockTokenOk();
		mockFuncOk();
		const res = await callWorker(postJson('/call', { name: 'f' }));
		expect(res.status).toBe(200);
	});

	it('POST /function 路径同样可用', async () => {
		mockTokenOk();
		mockFuncOk();
		const res = await callWorker(postJson('/function', { name: 'f' }));
		expect(res.status).toBe(200);
	});

	it('数字 version 被转为字符串参与 URL 拼接', async () => {
		mockTokenOk();
		const cap = mockFuncOk();
		await callWorker(postJson('/', { name: 'myfunc', version: 12 }));
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-12`);
	});

	it('version 为 0（falsy）时按 $latest 处理', async () => {
		mockTokenOk();
		const cap = mockFuncOk();
		await callWorker(postJson('/', { name: 'myfunc', version: 0 }));
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
	});

	it('timeout 为 0（falsy）时按默认值处理', async () => {
		mockTokenOk();
		mockFuncOk();
		const res = await callWorker(postJson('/', { name: 'myfunc', timeout: 0 }));
		expect(res.status).toBe(200);
	});

	it('timeout 非数字时按默认值处理', async () => {
		mockTokenOk();
		mockFuncOk();
		const res = await callWorker(postJson('/', { name: 'myfunc', timeout: 'not-a-number' }));
		expect(res.status).toBe(200);
	});
});

describe('兼容模式（AGC_DEFAULT_FUNCTION_NAME）', () => {
	it('无 name 时整个 body 作为 data 调用默认函数', async () => {
		mockTokenOk();
		const cap = mockFuncOk();
		const env = { ...BASE_ENV, AGC_DEFAULT_FUNCTION_NAME: 'defaultFn' };
		const res = await callWorker(postJson('/', { k: 1, list: [1, 2] }), env);
		expect(res.status).toBe(200);
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/defaultFn-$latest`);
		expect(cap.body).toBe('{"k":1,"list":[1,2]}');
	});

	it('body 为 JSON 数组时同样以 data 透传', async () => {
		mockTokenOk();
		const cap = mockFuncOk();
		const env = { ...BASE_ENV, AGC_DEFAULT_FUNCTION_NAME: 'defaultFn' };
		await callWorker(postJson('/', [1, 2, 3]), env);
		expect(cap.body).toBe('[1,2,3]');
	});
});

describe('错误码到 HTTP 状态映射', () => {
	it('部分环境变量凭据（有 AGC_CLIENT_ID 缺其余）返回 500，code 12000 并列出缺失字段', async () => {
		const res = await callWorker(postJson('/', { name: 'f' }), { AGC_CLIENT_ID: 'cid-123' });
		expect(res.status).toBe(500);
		const payload = await res.json();
		expect(payload.error.code).toBe('12000');
		expect(payload.error.message).toBe('the credential is null');
		expect(payload.error.detail).toContain('AGC_CLIENT_SECRET');
	});

	it('env 缺失时兜底 500 INTERNAL（非 AgcError 异常）', async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(postJson('/', { name: 'f' }), undefined, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(500);
		const payload = await res.json();
		expect(payload.error.code).toBe('INTERNAL');
		expect(payload.error.message).toBeTruthy();
	});

	it('timeout 越界返回 400，code 12004', async () => {
		const res = await callWorker(postJson('/', { name: 'f', timeout: 55001 }));
		expect(res.status).toBe(400);
		const payload = await res.json();
		expect(payload.error.code).toBe('12004');
		expect(payload.error.message).toBe('the value of timeout is out of range');
	});

	it('token 获取失败返回 502，code 12002', async () => {
		stub.post(
			TOKEN_URL,
			() => new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })
		);
		const res = await callWorker(postJson('/', { name: 'f' }));
		expect(res.status).toBe(502);
		const payload = await res.json();
		expect(payload.error.code).toBe('12002');
	});

	it('云函数返回非 2xx 时返回 502，code 12003 并透传 detail', async () => {
		mockTokenOk();
		mockFuncOk(() => new Response('cf-error-body', { status: 500 }));
		const res = await callWorker(postJson('/', { name: 'myfunc' }));
		expect(res.status).toBe(502);
		const payload = await res.json();
		expect(payload.error).toEqual({
			code: '12003',
			message: 'the method of call failed',
			detail: 'cf-error-body',
		});
	});
});

describe('自动配置模式（无环境变量凭据时使用 agconnect-services.json）', () => {
	// 真实配置解密后的 client 模式：客户端网关 + cpId/productId hash
	const GW = 'https://connect-drcn.dbankcloud.cn/';
	const CLIENT_TOKEN_URL = `${GW}agc/apigw/oauth2/v1/token`;
	const CLIENT_FUNC_BASE = `${GW}agc/apigw/wisefunction/functions/`;

	async function callWithoutEnvCred(body) {
		return callWorker(postJson('/', body), {});
	}

	it('无 AGC_* 环境变量时走客户端网关自动调用', async () => {
		const capture = {};
		stub.post(CLIENT_TOKEN_URL, async (req) => {
			capture.tokenBody = JSON.parse(await req.text());
			return new Response(JSON.stringify({ access_token: 'auto-tok', expires_in: 3600 }), { status: 200 });
		});
		stub.post(CLIENT_FUNC_BASE, async (req) => {
			capture.funcUrl = req.url;
			capture.funcHeaders = req.headers;
			return new Response('{"result":"auto-ok"}', { status: 200 });
		});

		const res = await callWithoutEnvCred({ name: 'autoFn', data: { x: 1 } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"result":"auto-ok"}');
		// token 请求使用真实配置解密出的 client_id（非环境变量）
		expect(capture.tokenBody.client_id).toBe('1263859182919011264');
		expect(capture.funcUrl.startsWith(CLIENT_FUNC_BASE)).toBe(true);
		expect(capture.funcUrl.endsWith('/autoFn')).toBe(true);
		expect(capture.funcHeaders.get('Authorization')).toBe('Bearer auto-tok');
	});

	it('存在 AGC_CLIENT_ID 时不回退自动配置，按服务端模式校验并报 12000', async () => {
		const res = await callWorker(postJson('/', { name: 'envFn' }), { AGC_CLIENT_ID: 'cid-123' });
		expect(res.status).toBe(500);
		const payload = await res.json();
		expect(payload.error.code).toBe('12000');
		expect(payload.error.detail).toContain('AGC_CLIENT_SECRET');
	});
});
