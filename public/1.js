/**
 * AGC 云网关地址与 SDK 公共请求头
 * （对应 SDK 的 agconnect-common.json + CloudGwUrlUtil + CommonHeaders）
 */

// 区域 → 项目级网关（region 来自凭据文件，PROJECT_CLIENT_ID 类型）
const REGION_GW = {
  CN: { url: 'https://connect-api.cloud.huawei.com/', backup: 'https://connect-api.cloud.huawei.com.cn/' },
  RU: { url: 'https://connect-api-drru.cloud.huawei.com/', backup: 'https://connect-api-drru.cloud.huawei.com.cn/' },
  SG: { url: 'https://connect-api-dra.cloud.huawei.com/', backup: 'https://connect-api-dra.cloud.huawei.com.cn/' },
  DE: { url: 'https://connect-api-dre.cloud.huawei.com/', backup: 'https://connect-api-dre.cloud.huawei.com.cn/' },
};

// 团队级网关（凭据无 region 时使用，TEAM_CLIENT_ID 类型）
const TEAM_GW = { url: 'https://agc-api.cloud.huawei.com/', backup: 'https://agc-api.cloud.huawei.com/' };

export const TOKEN_PATH = 'api/oauth2/v1/token';
export const FUNC_PATH = 'api/wisefunction/functions/';

// 按区域取网关地址；未匹配区域回退到团队级网关（与 SDK 行为一致）
export function getGateway(region, useBackup = false) {
  const gw = (region && REGION_GW[region]) || TEAM_GW;
  return useBackup ? gw.backup : gw.url;
}

// SDK 公共请求头（对应 CommonHeaders，uuid v1 去横线 → 随机 32 位 hex）
export function commonHeaders() {
  return {
    'User-Agent': 'AGCServerSDK/1.0.0',
    serverSdkName: 'node/cloud-server/common-server',
    serverSdkVersion: '1.0.0',
    'X-Request-Id': genRequestId(),
  };
}

function genRequestId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}