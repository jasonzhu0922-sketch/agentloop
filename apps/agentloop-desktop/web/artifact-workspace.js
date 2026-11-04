import { artifactPreviewMode, renderBlobPreview, renderStructuredPreview, updateArtifactPreviewMarkup } from './markdown.js';

// Desktop owns transport and selection; format routing/rendering is shared with
// Multi Runtime. Selection is scoped to Runtime + Run, including async reads.
export function createArtifactWorkspace({ element, api, onOpen }) {
  let scope; let turn; let selected; let revision = 0; let blobUrl; let listSignature;
  const host = element('artifact-preview');
  const node = (tag, className, text) => {
    const result = document.createElement(tag); result.className = className;
    if (text !== undefined) result.textContent = text; return result;
  };
  const endpoint = (item, action) => `/api/runs/${encodeURIComponent(turn.id)}/artifacts/${encodeURIComponent(item.id)}/${action}?runtimeId=${encodeURIComponent(scope.runtimeId)}`;
  function release() { if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = undefined; }
  function clear() {
    revision++; release(); selected = undefined;
    host.hidden = true; updateArtifactPreviewMarkup(host, '');
    element('artifact-download').hidden = true; element('artifact-download').removeAttribute('href');
    element('artifact-title').textContent = '产物预览';
    element('artifact-subtitle').textContent = '选择回复中的产物进行预览';
  }
  function render(nextTurn, runtimeId) {
    if (scope?.runtimeId !== runtimeId || scope?.runId !== nextTurn?.id) clear();
    scope = { runtimeId, runId: nextTurn?.id }; turn = nextTurn;
    const artifacts = turn?.artifacts || [];
    if (selected && !artifacts.some(item => item.id === selected)) clear();
    const signature = JSON.stringify([scope, selected, artifacts]);
    if (signature !== listSignature) {
      listSignature = signature;
      const container = element('artifacts'); container.replaceChildren();
      container.className = artifacts.length ? 'desktop-artifact-list' : 'artifact-empty';
      if (!artifacts.length) container.append(node('span', 'artifact-empty-icon', '▧'), node('strong', '', '暂无产物'), node('p', '', '任务生成的文件会在这里显示。'));
      for (const item of artifacts) {
        const button = node('button', `desktop-artifact${item.id === selected ? ' active' : ''}`); button.type = 'button';
        button.setAttribute('aria-pressed', String(item.id === selected));
        const name = node('span', '', item.name);
        name.append(node('small', '', `${item.bytes} 字节 · ${item.role === 'final' && turn.status === 'completed' ? '最终产物' : '阶段产物'} · 预览`));
        button.append(node('span', 'desktop-artifact-icon', '▤'), name);
        button.onclick = () => { void select(item.id); }; container.append(button);
      }
    }
    if (!element('details').hidden) activate();
  }
  function activate() {
    if (selected) return;
    const item = turn?.artifacts.find(item => item.role === 'final') || turn?.artifacts[0];
    if (item) void select(item.id);
  }
  async function select(id) {
    const item = turn?.artifacts.find(item => item.id === id); if (!item) return;
    if (selected === id) { onOpen(); return; }
    clear(); selected = id; const token = revision;
    const contentUrl = endpoint(item, 'content'); const previewUrl = endpoint(item, 'preview');
    element('artifact-title').textContent = item.name;
    element('artifact-subtitle').textContent = `${item.mimeType || '文件'} · ${item.bytes} 字节`;
    const download = element('artifact-download'); download.hidden = false;
    download.href = endpoint(item, 'download'); download.download = item.name;
    host.hidden = false; host.classList.remove('frame-body');
    updateArtifactPreviewMarkup(host, '<div class="artifact-preview-status" role="status">正在载入预览…</div>');
    render(turn, scope.runtimeId); onOpen();
    try {
      const mode = artifactPreviewMode({ ...item, mimeType: item.mimeType || '' }); let markup;
      if (mode === 'structured') {
        const preview = await api(previewUrl); if (token !== revision) return;
        markup = renderStructuredPreview(preview);
      } else {
        const response = await fetch(contentUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`无法读取产物（HTTP ${response.status}）`);
        if (token !== revision) return;
        let url = contentUrl;
        if (mode !== 'html') {
          const blob = await response.blob(); if (token !== revision) return;
          blobUrl = URL.createObjectURL(blob); url = blobUrl;
        }
        // A dedicated sandboxed HTTP document lets HTML run its own inline
        // styles/scripts without weakening the Desktop document's script CSP.
        markup = renderBlobPreview(mode, url, item.name);
        host.classList.toggle('frame-body', mode === 'html' || mode === 'pdf');
      }
      updateArtifactPreviewMarkup(host, markup);
    } catch (error) {
      if (token !== revision) return;
      updateArtifactPreviewMarkup(host, '');
      host.replaceChildren(node('p', 'artifact-preview-status error', error.message || '无法生成预览，请下载查看。'));
    }
  }
  function collapse() {
    element('details').classList.remove('maximized');
    element('artifact-maximize').setAttribute('aria-pressed', 'false');
    element('artifact-maximize').setAttribute('aria-label', '最大化产物区');
  }
  element('artifact-maximize').onclick = () => {
    const maximized = element('details').classList.toggle('maximized');
    element('artifact-maximize').setAttribute('aria-pressed', String(maximized));
    element('artifact-maximize').setAttribute('aria-label', maximized ? '还原产物区' : '最大化产物区');
  };
  window.addEventListener('pagehide', () => { revision++; release(); });
  return { render, select, activate, collapse };
}
