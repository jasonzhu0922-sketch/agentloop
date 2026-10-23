export function providerKeyNames(config) {
  if (!isRecord(config) || !isRecord(config.providers) || !isRecord(config.models)) throw new Error("配置必须包含 providers 和 models 对象");
  const names = [];
  for (const [providerKey, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider) || typeof provider.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) throw new Error(`Provider ${providerKey} 缺少有效的 apiKeyEnv`);
    if (!names.includes(provider.apiKeyEnv)) names.push(provider.apiKeyEnv);
  }
  return names;
}

export function readEnvValue(lines, name) {
  const line = [...lines].reverse().find((item) => item.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] === name);
  if (line === undefined) return "";
  const raw = line.slice(line.indexOf("=") + 1).trim();
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return unescapeEnv(raw.slice(1, -1));
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  return raw.replace(/\s+#.*$/, "");
}

export function mergeEnvLines(lines, entries) {
  const updates = new Map();
  for (const [rawName, value] of entries) {
    const name = rawName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`无效的环境变量名：${name}`);
    if (updates.has(name)) throw new Error(`环境变量重复：${name}`);
    updates.set(name, value);
  }
  const replaced = new Set();
  const output = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=).*/);
    if (!match || !updates.has(match[2])) return line;
    replaced.add(match[2]);
    return `${match[1]}${match[2]}${match[3]}${quoteEnv(updates.get(match[2]))}`;
  });
  for (const [name, value] of updates) if (!replaced.has(name)) output.push(`${name}=${quoteEnv(value)}`);
  return output;
}

function quoteEnv(value) {
  if (value === "") return "''";
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function unescapeEnv(value) { return value.replace(/\\(.)/g, "$1"); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
