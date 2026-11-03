const element = id => document.getElementById(id);
const registering = location.pathname === '/register';
document.title = registering ? '创建 AgentLoop 账号' : '登录 AgentLoop';
element('auth-title').textContent = registering ? '创建账号' : '欢迎回来';
element('auth-subtitle').textContent = registering ? '使用统一云端账号，对话和文件保存在本机。' : '登录你的云端账号，继续使用这台设备上的工作区。';
element('auth-submit').textContent = registering ? '创建账号' : '登录';
element('auth-switch-copy').textContent = registering ? '已有账号？' : '还没有账号？';
element('auth-mode-toggle').textContent = registering ? '登录' : '创建账号';
element('auth-mode-toggle').href = registering ? '/login' : '/register';
element('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
element('auth-email').maxLength = 254; element('auth-password').maxLength = 256;
const messages = {
  invalid_email: '邮箱格式不正确。', invalid_password: '密码应为 12 至 256 位。', invalid_credentials: '邮箱或密码错误。',
  email_registered: '该邮箱已注册，请直接登录。', cloud_auth_not_configured: 'Desktop 尚未配置云端账号服务。请设置账号服务地址后重启。',
  cloud_auth_unavailable: '云端账号服务暂时不可用，请检查网络或稍后重试。', cloud_auth_response_invalid: '账号服务返回了不兼容的响应。',
  cloud_auth_rate_limited: '尝试过于频繁，请稍后重试。', logout_before_account_switch: '已有登录账号，请先退出登录。',
};
if (new URLSearchParams(location.search).get('logout') === 'local-only') {
  element('auth-error').textContent = '本机已退出；云端暂不可达，远端凭据撤销未确认。活动任务不会自动取消。';
  element('auth-error').hidden = false;
}
let configured = false;
element('auth-submit').disabled = true;
try {
  const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('cloud_auth_unavailable');
  const config = await response.json(); configured = config.configured === true;
  element('auth-service').textContent = configured ? `云端账号服务：${config.issuer}。密码仅用于本次云端认证，不在本机保存。` : messages.cloud_auth_not_configured;
  element('auth-submit').disabled = !configured;
  const session = await fetch('/api/session', { credentials: 'same-origin' });
  if (session.ok) location.replace('/');
} catch { element('auth-service').textContent = messages.cloud_auth_unavailable; }
element('auth-form').onsubmit = async event => {
  event.preventDefault(); if (!configured || element('auth-submit').disabled) return;
  element('auth-error').hidden = true; element('auth-submit').disabled = true;
  try {
    const response = await fetch(`/api/auth/${registering ? 'register' : 'login'}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: element('auth-email').value.trim(), password: element('auth-password').value }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    // Credentials and cloud tokens never enter browser storage. HttpOnly cookie
    // is set by the local host; identity is checked again when the app loads.
    location.replace('/');
  } catch (error) {
    element('auth-error').textContent = messages[error.message] ?? '无法完成认证，请稍后重试。'; element('auth-error').hidden = false;
  } finally { element('auth-password').value = ''; element('auth-submit').disabled = false; }
};
