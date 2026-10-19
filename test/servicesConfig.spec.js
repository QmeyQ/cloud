// servicesConfig：[!...] 加密值解密、客户端凭据解析、缓存行为
import { describe, it, expect, afterEach } from 'vitest';
import {
	isEncryptedValue,
	derivePassword,
	parseClientCredential,
	getClientCredential,
	resetClientCredential,
} from '../src/agc/servicesConfig.js';
import servicesJson from '../src/agconnect-services.json';

// 自造密钥材料（非真实值），golden 输出由算法参考实现预生成
const CODE = {
	code1: '7f80f1701a2b3c4d5e6f70819a0b1c2d',
	code2: '0102fffe0a0b1415f0f1e0e1aa55cc33',
	code3: '8899aabbccddeeff0011223344556677',
	code4: 'deadbeefcafebabe0123456789abcdef',
};

function hexToBytes(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function bytesToHexUpper(bytes) {
	return [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// 按服务端格式构造 [!...] 密文：[0]=标记字节，[1..17)=IV，[17..]=AES-CBC(PKCS7) 密文
async function encryptForTest(text, code) {
	const password = derivePassword(code.code1, code.code2, code.code3);
	const baseKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-1', salt: hexToBytes(code.code4), iterations: 10000 },
		baseKey,
		128,
	);
	const aesKey = await crypto.subtle.importKey('raw', bits, { name: 'AES-CBC' }, false, ['encrypt']);
	const iv = crypto.getRandomValues(new Uint8Array(16));
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, aesKey, new TextEncoder().encode(text)),
	);
	const out = new Uint8Array(1 + 16 + cipher.length);
	out[0] = 0x01;
	out.set(iv, 1);
	out.set(cipher, 17);
	return '[!' + bytesToHexUpper(out) + ']';
}

function makeConfig(overrides = {}) {
	return {
		region: overrides.region ?? 'CN',
		client: {
			cp_id: '37123',
			product_id: '98765',
			project_id: 'proj-1',
			client_id: '10987654321',
			client_secret: 'plain-secret',
			api_key: 'plain-api-key',
			app_id: '123456789',
			package_name: 'com.example.app',
			...overrides.client,
		},
		code: { ...CODE, ...overrides.code },
		agcgw_all: {
			CN: 'connect-drcn.dbankcloud.cn',
			CN_back: 'connect-drcn.hispace.hicloud.com',
			...overrides.agcgw_all,
		},
	};
}

describe('isEncryptedValue', () => {
	it('识别合法 [!hex] 形态', () => {
		expect(isEncryptedValue('[!ABCDEF0123456789]')).toBe(true);
		expect(isEncryptedValue('[!abcdef]')).toBe(true);
		expect(isEncryptedValue('[!]')).toBe(true);
	});

	it('拒绝明文与其他形态', () => {
		expect(isEncryptedValue('plain-secret')).toBe(false);
		expect(isEncryptedValue('[!XYZ]')).toBe(false);
		expect(isEncryptedValue('[ABCDEF]')).toBe(false);
		expect(isEncryptedValue('[]')).toBe(false);

		expect(isEncryptedValue(null)).toBe(false);
		expect(isEncryptedValue(undefined)).toBe(false);
	});
});

describe('derivePassword', () => {
	it('golden 输出（Java byte 符号扩展语义）', () => {
		// 覆盖 0x7f/0x80 边界、0xff 符号位、负数左移与算术右移
		expect(derivePassword(CODE.code1, CODE.code2, CODE.code3)).toBe('77995544322311000011DDCC44AA6688');
	});

	it('输出为 32 位大写 hex', () => {
		const pwd = derivePassword(CODE.code1, CODE.code2, CODE.code3);
		expect(pwd).toMatch(/^[0-9A-F]{32}$/);
	});

	it('长度不一致时报错', () => {
		expect(() => derivePassword('aabb', CODE.code2, CODE.code3)).toThrow('长度不一致');
	});
});

describe('parseClientCredential', () => {
	it('解析明文配置为统一凭据结构', async () => {
		const cred = await parseClientCredential(makeConfig());
		expect(cred).toEqual({
			mode: 'client',
			clientId: '10987654321',
			clientSecret: 'plain-secret',
			apiKey: 'plain-api-key',
			cpId: '37123',
			productId: '98765',
			projectId: 'proj-1',
			appId: '123456789',
			packageName: 'com.example.app',
			region: 'CN',
			gateway: {
				url: 'https://connect-drcn.dbankcloud.cn/',
				backup: 'https://connect-drcn.hispace.hicloud.com/',
			},
		});
	});

	it('解密 [!] 加密的 client_secret 与 api_key（与 PBKDF2WithHmacSHA1/10000/AES-128-CBC 对齐）', async () => {
		const secret = await encryptForTest('MY-DECRYPTED-SECRET-123', CODE);
		const apiKey = await encryptForTest('DAEDAE==test', CODE);
		const cred = await parseClientCredential(makeConfig({ client: { client_secret: secret, api_key: apiKey } }));
		expect(cred.clientSecret).toBe('MY-DECRYPTED-SECRET-123');
		expect(cred.apiKey).toBe('DAEDAE==test');
	});

	it('secret 加密而 api_key 明文时可混合处理', async () => {
		const secret = await encryptForTest('mixed-secret', CODE);
		const cred = await parseClientCredential(makeConfig({ client: { client_secret: secret, api_key: 'plain-key' } }));
		expect(cred.clientSecret).toBe('mixed-secret');
		expect(cred.apiKey).toBe('plain-key');
	});

	it('网关 URL 自动补尾斜杠', async () => {
		const cred = await parseClientCredential(
			makeConfig({ agcgw_all: { SG: 'connect-dra.dbankcloud.cn', SG_back: 'connect-dra.hispace.hicloud.com' }, region: 'SG' }),
		);
		expect(cred.gateway).toEqual({
			url: 'https://connect-dra.dbankcloud.cn/',
			backup: 'https://connect-dra.hispace.hicloud.com/',
		});
	});

	it('缺 agcgw_all 时 gateway 为 null（由静态表兜底）', async () => {
		const cfg = makeConfig();
		delete cfg.agcgw_all;
		const cred = await parseClientCredential(cfg);
		expect(cred.gateway).toBeNull();
	});

	it('缺少 code 字段时报错', async () => {
		const cfg = makeConfig();
		delete cfg.code.code2;
		await expect(parseClientCredential(cfg)).rejects.toThrow('code.code2');
	});

	it('缺少 client 必需字段时报错', async () => {
		const cfg = makeConfig();
		delete cfg.client.cp_id;
		await expect(parseClientCredential(cfg)).rejects.toThrow('client.cp_id');
	});

	it('缺少 client/code 节点时报错', async () => {
		await expect(parseClientCredential({})).rejects.toThrow('client 或 code');
	});

	it('密文被篡改时解密失败报错', async () => {
		const secret = await encryptForTest('will-fail', CODE);
		const broken = '[!' + secret.slice(2, -1).slice(0, -2) + 'FF' + ']';
		await expect(
			parseClientCredential(makeConfig({ client: { client_secret: broken } })),
		).rejects.toThrow();
	});
});

describe('getClientCredential（真实配置冒烟）', () => {
	afterEach(() => {
		resetClientCredential();
	});

	it('真实 agconnect-services.json 解密成功，secret 为 64 位 hex、api_key 为 base64 形态', async () => {
		const cred = await getClientCredential();
		expect(cred.mode).toBe('client');
		expect(cred.clientId).toBe(servicesJson.client.client_id);
		expect(cred.clientSecret).toMatch(/^[0-9A-Fa-f]{64}$/);
		expect(cred.apiKey).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		expect(cred.gateway).toEqual({
			url: 'https://connect-drcn.dbankcloud.cn/',
			backup: 'https://connect-drcn.hispace.hicloud.com/',
		});
	});

	it('isolate 内缓存：并发与重复调用共享同一结果', async () => {
		const [a, b, c] = await Promise.all([getClientCredential(), getClientCredential(), getClientCredential()]);
		expect(a).toBe(b);
		expect(b).toBe(c);
		const again = await getClientCredential();
		expect(again).toBe(a);
	});
});