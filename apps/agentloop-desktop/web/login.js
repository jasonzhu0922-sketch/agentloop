const element = id => document.getElementById(id);
const registering = location.pathname === '/register';
const form = element('auth-form');
const submit = element('auth-submit');
const submitCopy = element('auth-submit-copy');
const idleCopy = registering ? '创建账号，开始协作' : '登录工作空间';
form.dataset.mode = registering ? 'register' : 'login';
document.title = registering ? '创建玄武账号' : '登录玄武';
element('auth-title').textContent = registering ? '认识一下，新的伙伴' : '欢迎回来';
element('auth-eyebrow').textContent = registering ? 'MEET YOUR AGENT' : 'WELCOME BACK';
element('auth-description').textContent = registering ? '创建你的账号，让玄武陪你完成下一个目标。' : '登录玄武，继续推进你的目标。';
submitCopy.textContent = idleCopy;
element('auth-switch-copy').textContent = registering ? '已经有账号了？' : '还没有账号？';
element('auth-mode-toggle').textContent = registering ? '返回登录 →' : '创建账号 →';
element('auth-mode-toggle').href = registering ? '/login' : '/register';
element('auth-password').autocomplete = registering ? 'new-password' : 'current-password';
element('auth-password').placeholder = registering ? '设置 12–256 位密码' : '请输入密码';
element('password-hint').hidden = !registering;
for (const name of ['name', 'confirm']) {
  element(`${name}-field`).hidden = !registering;
  element(`auth-${name}`).disabled = !registering;
  element(`auth-${name}`).required = registering;
}
const messages = {
  invalid_email: '邮箱格式不正确，请检查后重试。', invalid_password: '密码应为 12 至 256 位。', invalid_display_name: '昵称应为 2 至 40 个字符，且不能包含控制字符。', invalid_credentials: '邮箱或密码错误，请检查后重试。',
  email_registered: '该邮箱已注册，可以点击下方“返回登录”使用已有账号。', cloud_auth_not_configured: '尚未配置账号服务，请联系管理员配置后重启。',
  cloud_auth_unavailable: '暂时无法连接账号服务，请检查网络后重试。', cloud_auth_response_invalid: '账号服务响应异常，请稍后重试。',
  cloud_auth_rate_limited: '尝试过于频繁，请稍后重试。', logout_before_account_switch: '已有登录账号，请先退出登录。',
  account_data_migration_failed: '本机历史数据迁移未完成，原数据已保留。请查看本机数据完整性后重试。',
};
function showError(message) { element('auth-error').textContent = message; element('auth-error').hidden = false; }
if (new URLSearchParams(location.search).get('logout') === 'local-only') {
  showError('本机已退出；云端暂不可达，远端凭据撤销未确认。活动任务不会自动取消。');
}
const touched = new Set();
const names = registering ? ['name', 'email', 'password', 'confirm'] : ['email', 'password'];
function fieldMessage(name) {
  const input = element(`auth-${name}`), value = input.value;
  if (name === 'name') return value.trim().length < 2 || value.trim().length > 40 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ? '请输入 2–40 个字符的昵称。' : '';
  if (name === 'email') return !value.trim() ? '请输入邮箱。' : value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? '请输入有效的邮箱地址。' : '';
  if (name === 'password') return !value ? '请输入密码。' : registering && (value.length < 12 || value.length > 256) ? '密码需要 12–256 位。' : '';
  if (name === 'confirm') return !value ? '请再次输入密码。' : value !== element('auth-password').value ? '两次输入的密码不一致。' : '';
  return '';
}
function validate(name) {
  const message = fieldMessage(name), input = element(`auth-${name}`), error = element(`${name}-error`);
  error.textContent = message; error.hidden = !message;
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  return !message;
}
for (const name of names) {
  const input = element(`auth-${name}`);
  input.addEventListener('blur', () => { touched.add(name); validate(name); });
  input.addEventListener('input', () => {
    if (touched.has(name)) validate(name);
    if (name === 'password') {
      if (registering) {
        const valid = !fieldMessage('password');
        element('password-hint').classList.toggle('is-valid', valid);
        element('password-hint').textContent = valid ? '✓ 长度符合要求，建议使用独有的密码。' : '12–256 位，建议混合字母、数字或符号。';
      }
      if (touched.has('confirm')) validate('confirm');
    }
  });
}
for (const toggle of document.querySelectorAll('[data-password-target]')) {
  toggle.addEventListener('click', () => {
    const input = element(toggle.dataset.passwordTarget), showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(showing));
    toggle.setAttribute('aria-label', `${showing ? '隐藏' : '显示'}${input.id === 'auth-confirm' ? '确认密码' : '密码'}`);
  });
}
let configured = false;
form.addEventListener('submit', async event => {
  event.preventDefault(); if (!configured || submit.disabled) return;
  element('auth-error').hidden = true;
  const invalid = names.filter(name => { touched.add(name); return !validate(name); });
  if (invalid.length) { element(`auth-${invalid[0]}`).focus(); return; }
  submit.disabled = true; submit.setAttribute('aria-busy', 'true');
  submitCopy.textContent = registering ? '正在创建账号…' : '正在登录…';
  // Freeze submitted values while the request is in flight; confirmation stays local.
  for (const name of names) element(`auth-${name}`).readOnly = true;
  try {
    const response = await fetch(`/api/auth/${registering ? 'register' : 'login'}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: element('auth-email').value.trim(), password: element('auth-password').value,
        ...(registering ? { displayName: element('auth-name').value.trim() } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    // Credentials and tokens never enter browser storage; the host issues an HttpOnly cookie.
    submitCopy.textContent = registering ? '创建成功，正在进入…' : '登录成功，正在进入…';
    location.replace('/');
  } catch (error) {
    showError(messages[error.message] ?? '无法完成认证，请稍后重试。');
    element('auth-password').value = ''; element('auth-confirm').value = '';
    if (registering) { element('password-hint').textContent = '12–256 位，建议混合字母、数字或符号。'; element('password-hint').classList.remove('is-valid'); }
    submitCopy.textContent = idleCopy;
    submit.disabled = false; submit.removeAttribute('aria-busy');
  } finally { for (const name of names) element(`auth-${name}`).readOnly = false; }
});

try {
  const response = await fetch('/api/auth/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('cloud_auth_unavailable');
  const config = await response.json(); configured = config.configured === true;
  element('auth-service').textContent = configured ? '账号服务已连接 · 密码不在本机保存' : messages.cloud_auth_not_configured;
  element('auth-service').dataset.state = configured ? 'ready' : 'error';
  const session = await fetch('/api/session', { credentials: 'same-origin' });
  if (session.ok) location.replace('/');
  else submit.disabled = !configured;
} catch {
  element('auth-service').textContent = messages.cloud_auth_unavailable;
  element('auth-service').dataset.state = 'error';
}
