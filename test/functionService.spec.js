// callFunction：URL 拼接、认证请求头、body 序列化、timeout 校验与错误码
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFetchRouter } from './helpers/fetchRouter.js';
import { callFunction } from '../src/agc/functionService.js';
import { resetTokenCache } from '../src/agc/tokenService.js';

const GW = 'https://connect-api.cloud.huawei.com/';
const TOKEN_URL = `${GW}api/oauth2/v1/token`;
const FUNC_BASE = `${GW}api/wisefunction/functions/`;
const HASH = 'peyJV23AHvGVZ6lR4mAa0'; // hashFuncId('dev123', 'proj456')

const CRED = {
	projectId: 'proj456',
	region: 'CN',
	developerId: 'dev123',
	clientId: 'cid-123',
	clientSecret: 'sec-456',
};

let stub;

function mockTokenOk() {
	stub.post(
		TOKEN_URL,
		() => new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), { status: 200 })
	);
}

// 注册函数调用 mock 并捕获出站请求
function mockFuncOnce(reply = () => new Response('{"code":0}', { status: 200 })) {
	const capture = {};
	stub.post(FUNC_BASE, async (req) => {
		capture.url = req.url;
		capture.headers = req.headers;
		capture.body = await req.text();
		return reply();
	});
	return capture;
}

beforeEach(() => {
	resetTokenCache();
	stub = installFetchRouter();
});

afterEach(() => {
	stub.assertNoPending();
	stub.restore();
});

describe('callFunction 成功路径', () => {
	it('默认版本使用 $latest，携带认证头并序列化 data', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		const result = await callFunction(CRED, { name: 'myfunc', data: { a: 1 } });
		expect(result).toBe('{"code":0}');
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
		expect(cap.headers.get('Authorization')).toBe('Bearer tok-abc');
		expect(cap.headers.get('clientid')).toBe('cid-123');
		expect(cap.headers.get('productid')).toBe('proj456');
		expect(cap.headers.get('x-nuwa-trace-id')).toBe('');
		expect(cap.headers.get('Content-Type')).toBe('application/json');
		expect(cap.body).toBe('{"a":1}');
	});

	it('指定版本时 URL 使用 name-version', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc', version: 'v2', data: 1 });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-v2`);
	});

	it('空字符串版本按 $latest 处理', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc', version: '', data: 1 });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
	});

	it('data 为 undefined 时请求体为空字符串', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc' });
		expect(cap.body).toBe('');
	});

	it('data 为 null 时请求体为 "null"', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc', data: null });
		expect(cap.body).toBe('null');
	});

	it('timeout 取上边界 55000 仍可正常调用', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc', timeout: 55000 });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
	});

	it('timeout 取合法下边界 1 仍可正常调用', async () => {
		mockTokenOk();
		const cap = mockFuncOnce();
		await callFunction(CRED, { name: 'myfunc', timeout: 1 });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/myfunc-$latest`);
	});
});

describe('client 模式（agconnect-services.json 自动配置）', () => {
	const GW = 'https://connect-drcn.dbankcloud.cn/';
	const TOKEN_URL = `${GW}agc/apigw/oauth2/v1/token`;
	const FUNC_BASE = `${GW}agc/apigw/wisefunction/functions/`;
	const HASH = '1qhhTzn2IkyWxI3C5S0XKo'; // hashFuncId('37123', '98765')

	const CRED = {
		mode: 'client',
		clientId: 'cid-789',
		clientSecret: 'sec-012',
		cpId: '37123',
		productId: '98765',
		appId: '111222333',
		packageName: 'com.example.app',
		region: 'CN',
		gateway: { url: GW, backup: 'https://connect-drcn.hispace.hicloud.com/' },
	};

	function mockTokenOk() {
		stub.post(
			TOKEN_URL,
			() => new Response(JSON.stringify({ access_token: 'tok-xyz', expires_in: 3600 }), { status: 200 })
		);
	}

	// 注册客户端端点 mock 并捕获出站请求
	function mockClientFuncOnce() {
		const capture = {};
		stub.post(FUNC_BASE, async (req) => {
			capture.url = req.url;
			capture.headers = req.headers;
			capture.body = await req.text();
			return new Response('{"code":0}', { status: 200 });
		});
		return capture;
	}

	it('触发器名纯透传（不带 -$latest），hash 用 cpId@productId', async () => {
		mockTokenOk();
		const cap = mockClientFuncOnce();
		await callFunction(CRED, { name: 'mytrigger', data: { a: 1 } });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/mytrigger`);
		expect(cap.body).toBe('{"a":1}');
	});

	it('name 带前导斜杠时去除', async () => {
		mockTokenOk();
		const cap = mockClientFuncOnce();
		await callFunction(CRED, { name: '/mytrigger' });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/mytrigger`);
	});

	it('显式 version 时拼接 name-version', async () => {
		mockTokenOk();
		const cap = mockClientFuncOnce();
		await callFunction(CRED, { name: 'mytrigger', version: 'v3' });
		expect(cap.url).toBe(`${FUNC_BASE}${HASH}/mytrigger-v3`);
	});

	it('携带客户端 SDK 请求头', async () => {
		mockTokenOk();
		const cap = mockClientFuncOnce();
		await callFunction(CRED, { name: 'mytrigger' });
		expect(cap.headers.get('Authorization')).toBe('Bearer tok-xyz');
		expect(cap.headers.get('client_id')).toBe('cid-789');
		expect(cap.headers.get('productId')).toBe('98765');
		expect(cap.headers.get('appId')).toBe('111222333');
		expect(cap.headers.get('sdkServiceName')).toBe('agconnect-function');
		expect(cap.headers.get('sdkType')).toBe('JS');
		expect(cap.headers.get('packageName')).toBe('com.example.app');
		expect(cap.headers.get('Content-Type')).toBe('application/json;charset=UTF-8');
	});

	it('gateway 缺失时从 SG 候选开始，token 与函数调用同网关', async () => {
		const credNoGw = { ...CRED, gateway: null };
		const sgGw = 'https://connect-dra.dbankcloud.cn/';
		stub.post(
			`${sgGw}agc/apigw/oauth2/v1/token`,
			() => new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
		);
		const capture = {};
		stub.post(`${sgGw}agc/apigw/wisefunction/functions/`, async (req) => {
			capture.url = req.url;
			return new Response('{"code":0}', { status: 200 });
		});
		await callFunction(credNoGw, { name: 'mytrigger' });
		expect(capture.url.startsWith(`${sgGw}agc/apigw/wisefunction/functions/`)).toBe(true);
	});

	it('主网关 501 拦截时函数调用自动走 SG（token 回退后同网关）', async () => {
		// 主网关 token 返回 501 HTML（Cloudflare 出网被拦场景）
		stub.post(
			`${GW}agc/apigw/oauth2/v1/token`,
			() => new Response('<html>invalid request</html>', { status: 501, headers: { 'Content-Type': 'text/html' } })
		);
		const sgGw = 'https://connect-dra.dbankcloud.cn/';
		stub.post(
			`${sgGw}agc/apigw/oauth2/v1/token`,
			() => new Response(JSON.stringify({ access_token: 'sg-tok', expires_in: 3600 }), { status: 200 })
		);
		const capture = {};
		stub.post(`${sgGw}agc/apigw/wisefunction/functions/`, async (req) => {
			capture.url = req.url;
			capture.headers = req.headers;
			return new Response('{"code":0}', { status: 200 });
		});
		await callFunction(CRED, { name: 'mytrigger' });
		expect(capture.url.startsWith(`${sgGw}agc/apigw/wisefunction/functions/`)).toBe(true);
		expect(capture.headers.get('Authorization')).toBe('Bearer sg-tok');
	});
});

describe('timeout 越界校验（不发出站请求）', () => {
	it.each([0, -1, 55001, 99999])('timeout=%i 抛 12004', async (timeout) => {
		await expect(callFunction(CRED, { name: 'myfunc', timeout })).rejects.toMatchObject({
			code: '12004',
		});
	});
});

describe('callFunction 失败路径', () => {
	it('非 2xx 响应抛 12003，detail 为响应文本', async () => {
		mockTokenOk();
		mockFuncOnce(() => new Response('boom', { status: 500 }));
		let err;
		try {
			await callFunction(CRED, { name: 'myfunc' });
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12003');
		expect(err.message).toBe('the method of call failed');
		expect(err.detail).toBe('boom');
	});

	it('函数端点网络异常抛 12003', async () => {
		mockTokenOk();
		// 不注册函数端点 mock → 未匹配 → fetch 抛出 → 转为 12003
		let err;
		try {
			await callFunction(CRED, { name: 'myfunc' });
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12003');
		expect(err.detail).toBeTruthy();
	});

	it('token 获取失败向上传播 12002', async () => {
		stub.post(
			TOKEN_URL,
			() => new Response(JSON.stringify({ error: 'invalid' }), { status: 401 })
		);
		await expect(callFunction(CRED, { name: 'myfunc' })).rejects.toMatchObject({ code: '12002' });
	});
});