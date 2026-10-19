// hashFuncId：md5 十六进制大整数转 base62，输出需与 SDK 完全一致
import { describe, it, expect } from 'vitest';
import { hashFuncId } from '../src/agc/hashUtil.js';

describe('hashFuncId', () => {
	it('已知值 dev123/proj456', () => {
		expect(hashFuncId('dev123', 'proj456')).toBe('peyJV23AHvGVZ6lR4mAa0');
	});

	it('已知值 a/b', () => {
		expect(hashFuncId('a', 'b')).toBe('2MZbDKoXghQGCoVhOugKPP');
	});

	it('输出仅含 base62 字符表字符', () => {
		const out = hashFuncId('任意developerId', '任意projectId');
		expect(out).toMatch(/^[0-9a-zA-Z]+$/);
	});

	it('不同输入产生不同哈希', () => {
		expect(hashFuncId('dev1', 'proj1')).not.toBe(hashFuncId('dev2', 'proj2'));
	});
});