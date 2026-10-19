// md5Hex 纯 JS MD5 实现的已知向量测试（含 UTF-8 与分组填充边界）
import { describe, it, expect } from 'vitest';
import { md5Hex } from '../src/agc/md5.js';

describe('md5Hex 已知向量', () => {
	it('空字符串', () => {
		expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
	});

	it('hello world', () => {
		expect(md5Hex('hello world')).toBe('5eb63bbbe01eeed093cb22bb8f5acdc3');
	});

	it('UTF-8 中文按字节编码', () => {
		expect(md5Hex('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
	});

	it('经典测试句', () => {
		expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
			'9e107d9d372bb6826bd81d3542a419d6'
		);
	});

	// 分组填充边界：55 字节为单块内最大长度，56/64 字节触发跨块填充，200 字节为多块输入
	it.each([
		[55, 'ef1772b6dff9a122358552954ad0df65'],
		[56, '3b0c8ac703f828b04c6c197006d17218'],
		[64, '014842d480b571495a4a0363793f7367'],
		[200, '887f30b43b2867f4a9accceee7d16e6c'],
	])('长度 %i 的连续输入', (len, expected) => {
		expect(md5Hex('a'.repeat(len))).toBe(expected);
	});

	it('输出为 32 位小写十六进制', () => {
		expect(md5Hex('x')).toMatch(/^[0-9a-f]{32}$/);
	});

	it('hashFuncId 依赖的拼接串中间值', () => {
		// 该值是 hashFuncId('dev123','proj456') 的 base62 输入
		expect(md5Hex('agc:dev123@proj456')).toBe('0d5f89387547ef0afd562969b7a37b2c');
	});
});