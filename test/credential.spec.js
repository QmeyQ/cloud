// parseCredential：AGC_CREDENTIAL JSON 模式 / 分离字段模式 / 缺失校验
import { describe, it, expect } from 'vitest';
import { parseCredential } from '../src/agc/credential.js';

const SPLIT_ENV = {
	AGC_CLIENT_ID: 'cid-123',
	AGC_CLIENT_SECRET: 'sec-456',
	AGC_PROJECT_ID: 'proj456',
	AGC_DEVELOPER_ID: 'dev123',
	AGC_REGION: 'CN',
};

describe('parseCredential 分离字段模式', () => {
	it('完整分离字段映射到凭据对象', () => {
		const cred = parseCredential(SPLIT_ENV);
		expect(cred).toEqual({
			projectId: 'proj456',
			region: 'CN',
			developerId: 'dev123',
			clientId: 'cid-123',
			clientSecret: 'sec-456',
			configurationVersion: '',
			type: 'PROJECT_CLIENT_ID',
		});
	});

	it('可省略 AGC_REGION（region 默认空串）', () => {
		const { AGC_REGION, ...rest } = SPLIT_ENV;
		const cred = parseCredential(rest);
		expect(cred.region).toBe('');
		expect(cred.clientId).toBe('cid-123');
	});
});

describe('parseCredential AGC_CREDENTIAL JSON 模式', () => {
	it('完整凭据 JSON 的 snake_case 字段映射', () => {
		const env = {
			AGC_CREDENTIAL: JSON.stringify({
				project_id: 'json-proj',
				region: 'SG',
				developer_id: 'json-dev',
				client_id: 'json-cid',
				client_secret: 'json-sec',
				configuration_version: '1.2.3',
				type: 'PROJECT_CLIENT_ID',
			}),
		};
		expect(parseCredential(env)).toEqual({
			projectId: 'json-proj',
			region: 'SG',
			developerId: 'json-dev',
			clientId: 'json-cid',
			clientSecret: 'json-sec',
			configurationVersion: '1.2.3',
			type: 'PROJECT_CLIENT_ID',
		});
	});

	it('AGC_CREDENTIAL 优先级高于分离字段', () => {
		const env = {
			...SPLIT_ENV,
			AGC_CREDENTIAL: JSON.stringify({
				project_id: 'json-proj',
				developer_id: 'json-dev',
				client_id: 'json-cid',
				client_secret: 'json-sec',
			}),
		};
		const cred = parseCredential(env);
		expect(cred.clientId).toBe('json-cid');
		expect(cred.projectId).toBe('json-proj');
		expect(cred.developerId).toBe('json-dev');
	});

	it('TEAM_CLIENT_ID 类型允许缺少 project_id', () => {
		const env = {
			AGC_CREDENTIAL: JSON.stringify({
				developer_id: 'dev',
				client_id: 'cid',
				client_secret: 'sec',
				type: 'TEAM_CLIENT_ID',
			}),
		};
		const cred = parseCredential(env);
		expect(cred.type).toBe('TEAM_CLIENT_ID');
		expect(cred.projectId).toBe('');
	});

	it('非法 JSON 抛 12000 且 detail 说明来源', () => {
		let err;
		try {
			parseCredential({ AGC_CREDENTIAL: '{bad json' });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('12000');
		expect(err.detail).toContain('AGC_CREDENTIAL 不是合法 JSON');
	});
});

describe('parseCredential 缺失校验', () => {
	it('空 env 抛 12000 并列出全部缺失字段', () => {
		let err;
		try {
			parseCredential({});
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12000');
		expect(err.message).toBe('the credential is null');
		expect(err.detail).toContain('AGC_CLIENT_ID');
		expect(err.detail).toContain('AGC_CLIENT_SECRET');
		expect(err.detail).toContain('AGC_DEVELOPER_ID');
		expect(err.detail).toContain('AGC_PROJECT_ID');
	});

	it('缺 client_secret 与 developer_id 时一并列出', () => {
		let err;
		try {
			parseCredential({ AGC_CLIENT_ID: 'cid', AGC_PROJECT_ID: 'p' });
		} catch (e) {
			err = e;
		}
		expect(err.code).toBe('12000');
		expect(err.detail).toContain('AGC_CLIENT_SECRET');
		expect(err.detail).toContain('AGC_DEVELOPER_ID');
		expect(err.detail).not.toContain('AGC_PROJECT_ID');
	});

	it('env 为 undefined 时抛出异常（Worker 层兜底为 INTERNAL）', () => {
		expect(() => parseCredential(undefined)).toThrow();
	});
});