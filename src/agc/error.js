/**
 * AGC 错误定义（对应 SDK 的 FunctionErrorCode / AGCFunctionException）
 * 错误码沿用 SDK：12000-12004
 */

export const FunctionErrorCode = {
  GET_CREDENTIAL_NULL: '12000',
  GET_GW_URL_FAIL: '12001',
  GET_ACCESS_TOKEN_FAIL: '12002',
  CALL_CLOUD_FUNCTION_FAIL: '12003',
  TIMEOUT_OUT_OF_RANGE: '12004',
};

const errMsgMap = {
  [FunctionErrorCode.GET_CREDENTIAL_NULL]: 'the credential is null',
  [FunctionErrorCode.GET_GW_URL_FAIL]: 'get the url failed',
  [FunctionErrorCode.GET_ACCESS_TOKEN_FAIL]: 'get access token failed',
  [FunctionErrorCode.CALL_CLOUD_FUNCTION_FAIL]: 'the method of call failed',
  [FunctionErrorCode.TIMEOUT_OUT_OF_RANGE]: 'the value of timeout is out of range',
};

export function getErrMsg(code) {
  return errMsgMap[code] || 'internal error';
}

export class AgcError extends Error {
  constructor(code, detail) {
    super(getErrMsg(code));
    this.name = 'AgcError';
    this.code = code;
    this.detail = detail;
  }
}