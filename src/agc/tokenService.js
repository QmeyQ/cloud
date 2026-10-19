/**
 * Access Token 获取与缓存（对应 SDK 的 ClientIdCredential.refreshAccessToken + AccessToken）
 * POST {网关}/api/oauth2/v1/token，grant_type=client_credentials
 * token 在 isolate 生命周期内缓存，提前 2 分钟失效；并发请求共享同一次刷新
 *
 * 服务端模式：主网关网络异常时切换备用网关（对应 SDK checkUseBackUrl）
 * 客户端模式：华为 CN 区网关拦截 Cloudflare Workers 出网（501 invalid request，
 *   实测 2026-10），按候选列表自动回退（配置网关 → SG → RU → DE → 配置备网关），
 *   token 与函数调用必须使用同一网关（token 由签发网关校验，跨网关 205524993）
 */

import { getGateway, TOKEN_PATH, CLIENT_TOKEN_PATH, commonHeaders } from './config.js';
import { AgcError, FunctionErrorCode } from './error.js';

const TWO_MINUTES_EARLY = 120 * 1000;

// 客户端模式回退候选（配置网关之后依次尝试）。
// SG 实测可用且最快：接受 CN 区凭据，函数路由全球统一；RU/DE 为进一步兜底。
const CLIENT_FALLBACK_GWS = [
  'https://connect-dra.dbankcloud.cn/', // SG
  'https://connect-drru.hispace.dbankcloud.ru/', // RU
  'https://connect-dre.dbankcloud.cn/', // DE
];

let cached = null; // { token, expireAt, gateway? }
let pending = null; // 并发去重

export async function getAccessToken(cred) {
  if (cached && Date.now() <= cached.expireAt - TWO_MINUTES_EARLY) {
    return cached.token;
  }
  if (!pending) {
    pending = fetchToken(cred).finally(() => { pending = null; });
  }
  return pending;
}

// 客户端模式下当前可用的网关（token 与函数调用须同网关）；服务端模式返回区域网关
export async function getWorkingGateway(cred) {
  if (cred.mode !== 'client') {
    return getGateway(cred.region);
  }
  if (!cached || Date.now() > cached.expireAt - TWO_MINUTES_EARLY) {
    await getAccessToken(cred); // 填充缓存（含生效网关）
  }
  return cached.gateway;
}

function clientGatewayCandidates(cred) {
  const list = [];
  const push = (url) => {
    if (url && !list.includes(url)) list.push(url);
  };
  if (cred.gateway?.url) push(cred.gateway.url);
  for (const gw of CLIENT_FALLBACK_GWS) push(gw);
  if (cred.gateway?.backup) push(cred.gateway.backup);
  return list;
}

function tokenRequestBody(cred) {
  return JSON.stringify({
    grant_type: 'client_credentials',
    client_id: cred.clientId,
    client_secret: cred.clientSecret,
  });
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchToken(cred) {
  if (cred.mode === 'client') {
    return fetchClientToken(cred);
  }
  return fetchServerToken(cred);
}

// 客户端模式：候选网关依次尝试，任一返回合法 access_token 即生效
async function fetchClientToken(cred) {
  const body = tokenRequestBody(cred);
  const candidates = clientGatewayCandidates(cred);
  let lastErr = null;

  for (const gw of candidates) {
    try {
      const res = await fetch(gw + CLIENT_TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', algorithm_type: '1' },
        body,
      });
      const text = await res.text();
      const json = parseJsonSafe(text);
      if (res.ok && json?.access_token) {
        cached = {
          token: json.access_token,
          expireAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
          gateway: gw,
        };
        return cached.token;
      }
      // 501 HTML 拦截页 / 业务错误 JSON：切换下一候选，detail 保留现场便于诊断
      lastErr = new AgcError(
        FunctionErrorCode.GET_ACCESS_TOKEN_FAIL,
        `status=${res.status} gateway=${gw} body=${text.slice(0, 300)}`,
      );
    } catch (err) {
      lastErr = new AgcError(
        FunctionErrorCode.GET_ACCESS_TOKEN_FAIL,
        `gateway=${gw} ${err.message}`,
      );
    }
  }
  throw lastErr ?? new AgcError(FunctionErrorCode.GET_ACCESS_TOKEN_FAIL);
}

// 服务端模式：保持 SDK 行为，网络层失败才切备用网关
async function fetchServerToken(cred) {
  let res = null;
  let lastErr = null;
  for (const useBackup of [false, true]) {
    try {
      res = await fetch(getGateway(cred.region, useBackup) + TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', algorithm_type: '1', ...commonHeaders() },
        body: tokenRequestBody(cred),
      });
      break;
    } catch (err) {
      lastErr = err;
      res = null;
    }
  }

  if (!res) {
    throw new AgcError(FunctionErrorCode.GET_ACCESS_TOKEN_FAIL, lastErr?.message);
  }

  const text = await res.text();
  const json = parseJsonSafe(text);
  if (!res.ok || !json?.access_token) {
    // detail 带状态码与响应体片段，便于定位网关拦截（HTML 错误页等非 JSON 响应）
    throw new AgcError(
      FunctionErrorCode.GET_ACCESS_TOKEN_FAIL,
      `status=${res.status} body=${text.slice(0, 500)}`,
    );
  }

  cached = {
    token: json.access_token,
    expireAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  return cached.token;
}

// 供测试使用：清空缓存
export function resetTokenCache() {
  cached = null;
  pending = null;
}