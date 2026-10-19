/**
 * 云函数标识哈希（对应 SDK 的 HashUtil）
 * hash = base62( md5("agc:" + developerId + "@" + projectId) 的十六进制大整数 )
 * 使用 BigInt 替换 SDK 依赖的 bignumber.js，输出与 SDK 完全一致
 */

import { md5Hex } from './md5.js';

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function hashFuncId(developerId, projectId) {
  return bigIntToBase62(BigInt('0x' + md5Hex('agc:' + developerId + '@' + projectId)));
}

function bigIntToBase62(n) {
  let out = '';
  while (n > 61n) {
    out = BASE62[Number(n % 62n)] + out;
    n = n / 62n;
  }
  return BASE62[Number(n)] + out;
}