/**
 * AGC 云函数代理 Worker（@hw-agconnect/cloud-server 的 Cloudflare Workers 移植版）
 *
 * 支持两种配置模式（环境变量优先）：
 *   A. 服务端 SDK 模式：配置 AGC_CLIENT_ID / AGC_CLIENT_SECRET / AGC_PROJECT_ID /
 *      AGC_DEVELOPER_ID / AGC_REGION（或 AGC_CREDENTIAL 完整 JSON）
 *      走 connect-api.cloud.huawei.com + /api/** ，hash(developerId, projectId)
 *   B. 客户端配置自动模式（零配置）：src/agconnect-services.json 随 Worker 打包，
 *      自动解密 client_secret / api_key（PBKDF2WithHmacSHA1 + AES-128-CBC），
 *      走客户端网关（/agc/apigw/**）+ hash(cpId, productId)。
 *      网关候选回退：配置网关 → SG → RU → DE → 配置备用（华为 CN 区网关拦截
 *      Cloudflare Workers 出网，实测 2026-10，SG 网关接受 CN 区凭据且函数路由全球统一）
 *
 * 请求：
 *   POST /  body: { "name": "函数名(触发器URI)", "version": "版本(可选)", "data": 任意JSON(可选), "timeout": 毫秒(可选) }
 *   GET  /health
 *   GET  /debug   诊断：输出配置模式、生效网关与 token 状态（无敏感值）
 *   响应：云函数返回值原样透传
 */

import { parseCredential } from './agc/credential.js';
import { getClientCredential } from './agc/servicesConfig.js';
import { callFunction } from './agc/functionService.js';
import { getAccessToken, getWorkingGateway } from './agc/tokenService.js';
import { AgcError, FunctionErrorCode } from './agc/error.js';

// 环境变量显式凭据优先（服务端模式），否则用打包的 agconnect-services.json（客户端模式）
async function resolveCredential(env) {
  if (env.AGC_CREDENTIAL || env.AGC_CLIENT_ID) {
    return parseCredential(env);
  }
  try {
    return await getClientCredential();
  } catch (err) {
    throw new AgcError(FunctionErrorCode.GET_CREDENTIAL_NULL, `agconnect-services.json 配置无效: ${err.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true });
    }

    // 诊断端点：从当前运行环境请求 token 接口，返回真实响应（敏感字段打码）
    if (request.method === 'GET' && url.pathname === '/debug') {
      return debugToken(env);
    }

    if (request.method !== 'POST' || !['/', '/call', '/function'].includes(url.pathname)) {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: '请求体必须是合法 JSON' }, 400);
    }

    let funcParams;
    if (body && typeof body === 'object' && typeof body.name === 'string') {
      // SDK 模式：与 cloud.function().call({ name, version, data, timeout }) 参数一致
      funcParams = {
        name: body.name,
        version: body.version ? String(body.version) : '',
        data: body.data,
        timeout: Number(body.timeout) || undefined,
      };
    } else if (env.AGC_DEFAULT_FUNCTION_NAME) {
      // 兼容模式：整个请求体作为 data，函数名取默认配置
      funcParams = { name: env.AGC_DEFAULT_FUNCTION_NAME, version: '', data: body, timeout: undefined };
    } else {
      return jsonResponse({ error: '请求体需包含 name 字段，或配置 AGC_DEFAULT_FUNCTION_NAME' }, 400);
    }

    try {
      const cred = await resolveCredential(env);
      const result = await callFunction(cred, funcParams);
      return new Response(result, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    } catch (err) {
      return errorResponse(err);
    }
  },
};

// 诊断：输出当前配置模式、生效网关与 token 状态（不暴露任何敏感值）
async function debugToken(env) {
  // AGC_CREDENTIAL 结构指纹：仅顶层键名与关键字段是否存在，不输出值
  let credentialFingerprint = null;
  if (env.AGC_CREDENTIAL) {
    try {
      const raw = JSON.parse(env.AGC_CREDENTIAL);
      credentialFingerprint = {
        topLevelKeys: Object.keys(raw),
        hasClientId: raw.client_id !== undefined,
        hasClientSecret: raw.client_secret !== undefined,
        hasDeveloperId: raw.developer_id !== undefined,
        hasProjectId: raw.project_id !== undefined,
        looksLikeServicesJson: Boolean(raw.client || raw.code || raw.agcgw_all),
      };
    } catch {
      credentialFingerprint = { parseError: true };
    }
  }

  try {
    const cred = await resolveCredential(env);
    const started = Date.now();
    const token = await getAccessToken(cred);
    const gateway = await getWorkingGateway(cred);
    return jsonResponse({
      mode: cred.mode,
      region: cred.region,
      workingGateway: gateway,
      tokenReady: Boolean(token),
      elapsedMs: Date.now() - started,
      credentialFingerprint,
    });
  } catch (err) {
    // 诊断端点固定 200，便于浏览器/工具直接查看错误现场
    return jsonResponse({ ok: false, debugError: err.message, detail: err.detail ?? null, credentialFingerprint });
  }
}

// AgcError → HTTP 状态码映射（错误码沿用 SDK FunctionErrorCode 12000-12004）
function errorResponse(err) {  if (err instanceof AgcError) {
    const status =
      err.code === FunctionErrorCode.GET_CREDENTIAL_NULL ? 500 :
      err.code === FunctionErrorCode.TIMEOUT_OUT_OF_RANGE ? 400 :
      err.code === FunctionErrorCode.GET_ACCESS_TOKEN_FAIL ? 502 :
      502;
    const payload = { error: { code: err.code, message: err.message } };
    if (err.detail !== undefined && err.detail !== '') payload.error.detail = err.detail;
    return jsonResponse(payload, status);
  }
  console.error('调用云函数失败:', err);
  return jsonResponse({ error: { code: 'INTERNAL', message: err.message || 'internal error' } }, 500);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // 生产环境建议替换为具体域名
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}