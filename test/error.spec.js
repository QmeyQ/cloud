// 错误码契约：FunctionErrorCode 沿用 SDK 12000-12004，文案映射与 AgcError 结构
import { describe, it, expect } from 'vitest';
import { FunctionErrorCode, getErrMsg, AgcError } from '../src/agc/error.js';

describe('FunctionErrorCode 错误码契约', () => {
	it('错误码沿用 SDK 12000-12004', () => {
		expect(FunctionErrorCode).toEqual({
			GET_CREDENTIAL_NULL: '12000',
			GET_GW_URL_FAIL: '12001',
			GET_ACCESS_TOKEN_FAIL: '12002',
			CALL_CLOUD_FUNCTION_FAIL: '12003',
			TIMEOUT_OUT_OF_RANGE: '12004',
		});
	});
});

describe('getErrMsg 错误文案映射', () => {
	it.each([
		['12000', 'the credential is null'],
		['12001', 'get the url failed'],
		['12002', 'get access token failed'],
		['12003', 'the method of call failed'],
		['12004', 'the value of timeout is out of range'],
	])('错误码 %s 映射固定文案', (code, message) => {
		expect(getErrMsg(code)).toBe(message);
	});

	it('未知错误码回退 internal error', () => {
		expect(getErrMsg('99999')).toBe('internal error');
	});
});

describe('AgcError 错误结构', () => {
	it('携带错误码与 detail', () => {
		const err = new AgcError(FunctionErrorCode.GET_ACCESS_TOKEN_FAIL, 'extra detail');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('AgcError');
		expect(err.code).toBe('12002');
		expect(err.message).toBe('get access token failed');
		expect(err.detail).toBe('extra detail');
	});

	it('detail 缺省为 undefined', () => {
		const err = new AgcError(FunctionErrorCode.GET_CREDENTIAL_NULL);
		expect(err.detail).toBeUndefined();
		expect(err.message).toBe('the credential is null');
	});
});