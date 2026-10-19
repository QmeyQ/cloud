// 网关地址、路径常量与 SDK 公共请求头
import { describe, it, expect } from 'vitest';
import {
	getGateway,

	TOKEN_PATH,
	FUNC_PATH,
	CLIENT_TOKEN_PATH,
	CLIENT_FUNC_PATH,
	commonHeaders,
} from '../src/agc/config.js';

describe('路径常量', () => {
	it('token 与云函数路径', () => {
		expect(TOKEN_PATH).toBe('api/oauth2/v1/token');
		expect(FUNC_PATH).toBe('api/wisefunction/functions/');
	});

	it('客户端协议 token 与云函数路径', () => {
		expect(CLIENT_TOKEN_PATH).toBe('agc/apigw/oauth2/v1/token');
		expect(CLIENT_FUNC_PATH).toBe('agc/apigw/wisefunction/functions/');
	});
});

describe('getGateway 区域网关', () => {
	it('CN 主/备网关', () => {
		expect(getGateway('CN')).toBe('https://connect-api.cloud.huawei.com/');
		expect(getGateway('CN', true)).toBe('https://connect-api.cloud.huawei.com.cn/');
	});

	it.each([
		['RU', 'https://connect-api-drru.cloud.huawei.com/', 'https://connect-api-drru.cloud.huawei.com.cn/'],
		['SG', 'https://connect-api-dra.cloud.huawei.com/', 'https://connect-api-dra.cloud.huawei.com.cn/'],
		['DE', 'https://connect-api-dre.cloud.huawei.com/', 'https://connect-api-dre.cloud.huawei.com.cn/'],
	])('%s 区域主/备网关', (region, mainUrl, backupUrl) => {
		expect(getGateway(region)).toBe(mainUrl);
		expect(getGateway(region, true)).toBe(backupUrl);
	});

	it.each(['XX', undefined, ''])('未知/缺失区域 %p 回退团队级网关', (region) => {
		expect(getGateway(region)).toBe('https://agc-api.cloud.huawei.com/');
		expect(getGateway(region, true)).toBe('https://agc-api.cloud.huawei.com/');
	});
});


describe('commonHeaders 公共请求头', () => {
	it('包含 SDK 标识头与 32 位随机 X-Request-Id', () => {
		const headers = commonHeaders();
		expect(headers['User-Agent']).toBe('AGCServerSDK/1.0.0');
		expect(headers.serverSdkName).toBe('node/cloud-server/common-server');
		expect(headers.serverSdkVersion).toBe('1.0.0');
		expect(headers['X-Request-Id']).toMatch(/^[0-9a-f]{32}$/);
	});

	it('X-Request-Id 每次随机生成', () => {
		expect(commonHeaders()['X-Request-Id']).not.toBe(commonHeaders()['X-Request-Id']);
	});
});