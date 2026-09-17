# Runtime Host 基线契约

Runtime Host 只能在声明的工具、Python 模块、Node 模块均已可用后注册并接收 Run。它不得在 Run 执行或 recovery 中执行 `pip install`、`npm install` 或修补镜像。

`requirements.txt` 是所有 bundled Skills 共用的 Python 基线，集中固定兼容区间，避免某个 Skill 的临时安装污染另一个 Skill：

| 能力 | 基线内容 |
| --- | --- |
| PDF | `pypdf`、`pdfplumber`、`reportlab`、`qpdf`、Poppler、Ghostscript |
| Office Open XML | `markitdown[pptx]`、`openpyxl`、`pandas`、`Pillow`、`lxml`、`defusedxml`、`pandoc` |
| 数据/数据库 | `numpy`、`PyMySQL` |
| 图像/OCR/GIF | `imageio`、`imageio-ffmpeg`、`Pillow`、`pytesseract`、`pdf2image`、Tesseract、FFmpeg |
| Web QA | Python `playwright` 和 Chromium |
| MCP/模型适配 | `mcp`、`anthropic` |

## Docker 预装

`Dockerfile` 和 `Dockerfile.runtime-host-overlay` 都执行以下等价流程：

```sh
apt-get install -y ffmpeg fonts-noto-cjk ghostscript pandoc poppler-utils \
  python3 python3-venv qpdf tesseract-ocr unzip zip
python3 -m venv /opt/agentloop-runtime-tools
/opt/agentloop-runtime-tools/bin/pip install -r requirements.txt
/opt/agentloop-runtime-tools/bin/python -m playwright install --with-deps chromium
```

默认使用镜像基础层的 Debian 源。若该源在部署网络中不可达，可在构建时显式提供合规镜像，而不是让构建无限等待：

```sh
docker build --build-arg APT_MIRROR=https://mirrors.aliyun.com/debian \
  --file apps/agentloop-multi-runtime/Dockerfile.runtime-host-overlay \
  --tag agentloop-multi-runtime:runtime-baseline-local .
```

Node 基线由 `apps/agentloop-multi-runtime/package.json` 和根 `package-lock.json` 锁定。构建时先 `npm ci --ignore-scripts`，随后只为需要原生二进制的 `sharp` 执行：

```sh
npm rebuild sharp --workspace agentloop-multi-runtime --foreground-scripts
```

预装并在 Host 启动时实际加载的 Node 模块为 `docx`、`pptxgenjs`、`react`、`react-dom`、`react-icons`、`sharp`。这里是模块加载，不是 `require.resolve`，所以 `sharp` 缺失原生二进制会阻止 Host 就绪。

## 本地 Host

`npm run start:local --workspace agentloop-multi-runtime` 创建或更新 `data/local/runtime-tools` 虚拟环境，按同一 `requirements.txt` 安装，并仅在 Chromium 不存在时下载它。系统命令仍由宿主机包管理器提供；启动时将逐个验证，缺任一项即拒绝注册 Host。

## LibreOffice 不是基线

基础 Host 不安装 `soffice`。PDF 合并/拆分/提取、OCR、DOCX/PPTX/XLSX 的结构读写不依赖它。只有下列任务需要单独调度到 Office-capable Host：旧 `.doc`/`.ppt` 转换、原生 Office 公式重算、DOCX/PPTX 的 Office 渲染转 PDF 后视觉验收。该 Host 额外安装 LibreOffice 并显式声明 `RUNTIME_REQUIRED_COMMANDS` 含 `soffice`；不能把它伪装成基础能力。

## 准入证据

镜像构建验证 Python imports、MarkItDown 版本、Playwright Chromium 安装和 `sharp` 原生重建。Host 启动再验证：系统命令、Python imports/Chromium 可执行文件、Node 模块实际加载。任何一项失败，Host 在建状态库和监听端口前退出，因此不会再接受一个必然因为缺工具而进入 recovery 的 Run。
