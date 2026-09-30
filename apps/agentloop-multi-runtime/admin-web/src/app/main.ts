const root = document.querySelector<HTMLElement>("#root");
if (root !== null) {
  root.innerHTML = `
    <main data-admin-app="control-plane">
      <h1>AgentLoop 管理控制面</h1>
      <p>所有数据通过独立 Admin API 获取；浏览器不连接数据库、Router 或 Runtime Host。</p>
      <nav aria-label="管理模块">
        <a href="#models">Model / Integration</a>
        <a href="#skills">Skill</a>
        <a href="#policies">Policy</a>
        <a href="#runtimes">Runtime</a>
        <a href="#members">成员</a>
        <a href="#traces">Run trace</a>
        <a href="#audit">Audit</a>
      </nav>
      <section id="runtimes"><h2>Runtime</h2><p>Drain / recovery 操作需要 Admin API 权限与 expected revision。</p></section>
      <section id="traces"><h2>Run trace</h2><p>仅展示 Router、Runtime、Control Plane 已记录事实；缺失事实会明确标注。</p></section>
    </main>`;
}
