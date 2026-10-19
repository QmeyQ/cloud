/**
 * 凭据解析（对应 SDK 的 CredentialParser + ClientIdCredential）
 * Workers 无文件系统，改为从环境变量构建：
 *   方式一：AGC_CREDENTIAL = 完整凭据 JSON 字符串（AGC 控制台下载的 agc-apiclient-*.json 内容，
 *           对应 SDK 的 PROJECT_CREDENTIAL 环境变量）
 *   方式二：分离字段 AGC_CLIENT_ID / AGC_CLIENT_SECRET / AGC_PROJECT_ID /
 *           AGC_DEVELOPER_ID / AGC_REGION（推荐，secret 单独管理）
 */

import { AgcError, FunctionErrorCode } from './error.js';

export function parseCredential(env) {
  let cred = null;

  if (env.AGC_CREDENTIAL) {
    try {
      cred = JSON.parse(env.AGC_CREDENTIAL);
    } catch (err) {
      throw new AgcError(FunctionErrorCode.GET_CREDENTIAL_NULL, `AGC_CREDENTIAL 不是合法 JSON: ${err.message}`);
    }
    // 识别误粘客户端配置文件（agconnect-services.json：顶层 client/code/agcgw_all 节点）
    if (cred && (cred.client || cred.code || cred.agcgw_all)) {
      throw new AgcError(
        FunctionErrorCode.GET_CREDENTIAL_NULL,
        'AGC_CREDENTIAL 是客户端配置文件（agconnect-services.json），不是服务端凭据。请在 AGC 控制台「项目设置 → 常规 → 项目凭据」创建/下载服务端凭据 JSON（顶层含 client_id/client_secret/developer_id/project_id）',
      );
    }
  }

  const c = {
    projectId: cred?.project_id ?? env.AGC_PROJECT_ID ?? '',
    region: cred?.region ?? env.AGC_REGION ?? '',
    developerId: cred?.developer_id ?? env.AGC_DEVELOPER_ID ?? '',
    clientId: cred?.client_id ?? env.AGC_CLIENT_ID ?? '',
    clientSecret: cred?.client_secret ?? env.AGC_CLIENT_SECRET ?? '',
    configurationVersion: cred?.configuration_version ?? '',
    type: cred?.type ?? 'PROJECT_CLIENT_ID',
  };

  // PROJECT_CLIENT_ID 类型必须有 projectId（团队级凭据可无）
  const missing = [];
  if (!c.clientId) missing.push('AGC_CLIENT_ID');
  if (!c.clientSecret) missing.push('AGC_CLIENT_SECRET');
  if (!c.developerId) missing.push('AGC_DEVELOPER_ID');
  if (c.type === 'PROJECT_CLIENT_ID' && !c.projectId) missing.push('AGC_PROJECT_ID');
  if (missing.length > 0) {
    throw new AgcError(FunctionErrorCode.GET_CREDENTIAL_NULL, `缺少凭据配置: ${missing.join(', ')}`);
  }

  return c;
}