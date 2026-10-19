/**
 * 云函数调用（对应 SDK 的 AGCFunction + FunctionCallable + RequestHeaders）
 * POST {网关}/api/wisefunction/functions/{hash}/{函数名-版本}
 *   - 版本缺省时使用 -$latest
 *   - 认证：Bearer token + clientid/productid 请求头
 *   - 请求体：调用参数 data 本身（与 SDK call({ data }) 一致）
 */

import { getGateway, FUNC_PATH, CLIENT_FUNC_PATH, commonHeaders } from './config.js';
import { getAccessToken, getWorkingGateway } from './tokenService.js';
import { hashFuncId } from './hashUtil.js';
import { AgcError, FunctionErrorCode } from './error.js';

const TIMEOUT_MAX = 55000;

export async function callFunction(cred, { name, version, data, timeout }) {
  const tmo = timeout ?? TIMEOUT_MAX;
  if (tmo <= 0 || tmo > TIMEOUT_MAX) {
    throw new AgcError(FunctionErrorCode.TIMEOUT_OUT_OF_RANGE, `timeout=${tmo}，有效范围 (0, 55000] ms`);
  }

  const isClient = cred.mode === 'client';
  // 服务端 SDK：hash(developerId, projectId)，触发器名 {name}-{version|$latest}
  // 客户端 SDK：hash(cpId, productId)，触发器 URI 纯透传（name），显式传 version 时拼 {name}-{version}
  const funcHash = isClient ? hashFuncId(cred.cpId, cred.productId) : hashFuncId(cred.developerId, cred.projectId);
  const trigger = isClient
    ? (version ? `${name}-${version}` : name).replace(/^\/+/, '')
    : `${name}-${version || '$latest'}`;

  const token = await getAccessToken(cred);
  if (!token) {
    throw new AgcError(FunctionErrorCode.GET_ACCESS_TOKEN_FAIL);
  }

  // 客户端模式：函数调用与 token 签发必须同网关（各网关只校验自己签发的 Bearer）
  const base = isClient ? await getWorkingGateway(cred) : getGateway(cred.region);
  const url = base + (isClient ? CLIENT_FUNC_PATH : FUNC_PATH) + funcHash + '/' + trigger;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: isClient ? clientFunctionHeaders(cred, token) : serverFunctionHeaders(cred, token),
      body: data === undefined ? '' : JSON.stringify(data),
      signal: AbortSignal.timeout(tmo),
    });
  } catch (err) {
    throw new AgcError(FunctionErrorCode.CALL_CLOUD_FUNCTION_FAIL, err.message);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new AgcError(FunctionErrorCode.CALL_CLOUD_FUNCTION_FAIL, text);
  }
  // 对应 SDK FunctionResult.getValue()：直接返回网关响应体
  return text;
}

// 服务端 SDK 请求头（RequestHeaders + CommonHeaders）
function serverFunctionHeaders(cred, token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    clientid: cred.clientId,
    productid: cred.projectId,
    'x-nuwa-trace-id': '',
    ...commonHeaders(),
  };
}

// 客户端 SDK 请求头（credential-ohos BaseRequest.getHeader + FunctionBackend Authorization）
function clientFunctionHeaders(cred, token) {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    Authorization: `Bearer ${token}`,
    client_id: cred.clientId,
    productId: cred.productId,
    appId: cred.appId,
    sdkVersion: '1.0.0',
    sdkPlatform: 'OpenHarmony',
    sdkServiceName: 'agconnect-function',
    sdkPlatformVersion: '',
    sdkType: 'JS',
    packageName: cred.packageName,
    appVersion: '',
    access_token: '',
  };
}