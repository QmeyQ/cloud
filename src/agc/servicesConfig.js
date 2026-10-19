/**
 * agconnect-services.json 自动配置（对应客户端 SDK 的 ServicesConfigImpl + DecryptExclamationMark）
 *
 * AGC 控制台下载的客户端配置中，client_secret / api_key 为 "[!十六进制]" 加密形态，
 * 需用文件内 code.code1~code4 解密后才能使用。解密链路（逆向自 agconnect-core 1.9.6.300）：
 *   1. 密码推导（Java byte 符号扩展语义，逐字节）：
 *        s1 = (byte)(x << 4); s2 = (byte)(s1 ^ y); s3 = (byte)(s2 >> 6); s4 = (byte)(s3 ^ z)
 *        其中 x/y/z = Hex.decode(code1/code2/code3)，password = 大写 HEX(s4)
 *   2. AES 密钥：PBKDF2WithHmacSHA1(password, salt=Hex.decode(code4), 10000 次, 128bit)
 *   3. 解密：AES-128-CBC + PKCS7，密文字节 [1..17) 为 IV，[17..] 为数据（第 0 字节为格式标记）
 *
 * 客户端网关与服务端 SDK 网关不同（如 CN 区为 connect-drcn.dbankcloud.cn），
 * token / 云函数路径分别为 /agc/apigw/oauth2/v1/token 与 /agc/apigw/wisefunction/functions/
 */

import servicesJson from '../agconnect-services.json';

const ITERATIONS = 10000;
const KEY_BITS = 128;

// "[!...]" 加密值识别（与 SDK 的正则 ^\[!([A-Fa-f0-9]*)] 一致）
export function isEncryptedValue(value) {
  return typeof value === 'string' && /^\[!([A-Fa-f0-9]*)]$/.test(value);
}

// Java byte 语义：加载符号扩展，存储截断为 byte
function sext(b) {
  return b << 24 >> 24;
}

// 密码推导：对应 Android SDK Keys.a([B[B[B)，输出 32 位大写 hex 字符串
export function derivePassword(code1, code2, code3) {
  const x = hexToBytes(code1);
  const y = hexToBytes(code2);
  const z = hexToBytes(code3);
  if (x.length !== y.length || y.length !== z.length) {
    throw new Error('code1/code2/code3 长度不一致');
  }
  let pwd = '';
  for (let i = 0; i < x.length; i++) {
    const s1 = (sext(x[i]) << 4) & 0xff;
    const s2 = (sext(s1) ^ sext(y[i])) & 0xff;
    const s3 = (sext(s2) >> 6) & 0xff;
    const s4 = (sext(s3) ^ sext(z[i])) & 0xff;
    pwd += s4.toString(16).toUpperCase().padStart(2, '0');
  }
  return pwd;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error(`非法十六进制串: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// 由 code1~code4 推导 AES 密钥（Web Crypto PBKDF2-SHA1）
async function deriveAesKey(code) {
  const password = derivePassword(code.code1, code.code2, code.code3);
  const salt = hexToBytes(code.code4);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt, iterations: ITERATIONS },
    baseKey,
    KEY_BITS,
  );
  return crypto.subtle.importKey('raw', bits, { name: 'AES-CBC' }, false, ['decrypt']);
}

// 解密单个 "[!hex]" 值：IV = 密文[1..17)，数据 = 密文[17..)，AES-CBC 自动去 PKCS7 填充
async function decryptValue(encrypted, aesKey) {
  const cipher = hexToBytes(/^\[!([A-Fa-f0-9]*)]$/.exec(encrypted)[1]);
  const iv = cipher.slice(1, 17);
  const data = cipher.slice(17);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, data);
  return new TextDecoder().decode(plain);
}

// 若值是加密形态则解密，否则原样返回（明文配置兼容）
async function resolveValue(value, aesKey) {
  return isEncryptedValue(value) ? decryptValue(value, aesKey) : value;
}

/**
 * 解析配置对象为客户端凭据（纯函数，便于测试注入）
 * 返回统一凭据结构（mode: 'client'），供 tokenService / functionService 分支使用
 */
export async function parseClientCredential(json) {
  const client = json?.client;
  const code = json?.code;
  if (!client || !code) {
    throw new Error('配置缺少 client 或 code 节点');
  }

  const missing = ['code1', 'code2', 'code3', 'code4'].filter(k => !code[k]);
  if (missing.length > 0) {
    throw new Error(`配置缺少 code.${missing.join('/code.')}`);
  }

  let aesKey = null;
  let clientSecret = client.client_secret ?? '';
  let apiKey = client.api_key ?? '';
  if (isEncryptedValue(clientSecret) || isEncryptedValue(apiKey)) {
    aesKey = await deriveAesKey(code);
    if (isEncryptedValue(clientSecret)) clientSecret = await decryptValue(clientSecret, aesKey);
    if (isEncryptedValue(apiKey)) apiKey = await decryptValue(apiKey, aesKey);
  }

  const missingClient = [];
  if (!client.client_id) missingClient.push('client.client_id');
  if (!clientSecret) missingClient.push('client.client_secret');
  if (!client.cp_id) missingClient.push('client.cp_id');
  if (!client.product_id) missingClient.push('client.product_id');
  if (missingClient.length > 0) {
    throw new Error(`配置缺少 ${missingClient.join(' / ')}`);
  }

  return {
    mode: 'client',
    clientId: String(client.client_id),
    clientSecret,
    apiKey,
    cpId: String(client.cp_id),
    productId: String(client.product_id),
    projectId: client.project_id ? String(client.project_id) : '',
    appId: client.app_id ? String(client.app_id) : '',
    packageName: client.package_name ?? '',
    region: json.region ?? 'CN',
    gateway: parseGateway(json),
  };
}

// 客户端网关（agcgw_all），形如 { url, backup }；缺失时由 config.js 的静态表兜底
function parseGateway(json) {
  const all = json?.agcgw_all ?? {};
  const region = json?.region ?? 'CN';
  const url = all[region];
  const backup = all[`${region}_back`];
  if (!url) return null;
  return { url: normalizeUrl(url), backup: backup ? normalizeUrl(backup) : normalizeUrl(url) };
}

// agcgw_all 中为裸域名，统一补协议与尾斜杠
function normalizeUrl(url) {
  const withScheme = url.startsWith('http') ? url : 'https://' + url;
  return withScheme.endsWith('/') ? withScheme : withScheme + '/';
}

// isolate 生命周期内只解密一次，并发请求共享
let initPromise = null;

export function getClientCredential() {
  if (!initPromise) {
    initPromise = parseClientCredential(servicesJson).catch(err => {
      initPromise = null; // 失败不缓存，下次请求重试
      throw err;
    });
  }
  return initPromise;
}

// 供测试使用：清空缓存
export function resetClientCredential() {
  initPromise = null;
}