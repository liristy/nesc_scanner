// Only attributed device timeouts may finish with a retained evidence gap.
// Authentication, cancellation, persistence and integrity failures remain fatal.
export function isDeviceTimeout(error) {
  if(['AUTH_REQUIRED','ABORT_ERR','EACCES','ENOSPC','EIO'].includes(error?.code)||error?.name==='AbortError')return false;
  const message=String(error?.message ?? error ?? '');
  if(/AUTH_REQUIRED|AbortError|取消|凭据|验证码|登录失效|保存失败|写入失败|覆盖核验不符|总数变化|记录不一致|身份不符/.test(message))return false;
  return ['DETAIL_TAB_TIMEOUT','HEARTBEAT_REQUEST_TIMEOUT','ETIMEDOUT'].includes(error?.code) ||
    /标签页等待超时|心跳接口请求失败或超时|请求超时|读取超时|等待超时|\bTimeout(?:Error)?\b|\btimed out\b/i.test(message);
}
