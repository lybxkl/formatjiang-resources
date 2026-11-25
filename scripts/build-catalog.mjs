import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedResourceFields = new Set(['name', 'url', 'description', 'tags', 'icon']);
const allowedCategoryFields = new Set(['id', 'name', 'description']);
const allowedIconExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const maximumIconBytes = 512 * 1024;
const maximumResources = 2000;
const windowsReservedNamePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function invalid(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, maximumLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(`${field} 必须是非空字符串`);
  }
  const result = value.trim();
  if (Array.from(result).length > maximumLength) {
    invalid(`${field} 不能超过 ${maximumLength} 个字符`);
  }
  return result;
}

function identifier(value, field) {
  const result = text(value, field, 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) {
    invalid(`${field} 只能使用小写字母、数字和连字符`);
  }
  if (windowsReservedNamePattern.test(result)) {
    invalid(`${field} 不能使用 Windows 保留文件名`);
  }
  return result;
}

function compareText(left, right) {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftNext = leftPoints.next();
    const rightNext = rightPoints.next();
    if (leftNext.done || rightNext.done) {
      if (leftNext.done && rightNext.done) return 0;
      return leftNext.done ? -1 : 1;
    }
    const leftPoint = leftNext.value.codePointAt(0);
    const rightPoint = rightNext.value.codePointAt(0);
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
}

async function readYaml(filePath) {
  let source;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    invalid(`无法读取 ${path.relative(repositoryRoot, filePath)}：${error.message}`);
  }
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: true });
  if (document.errors.length > 0) {
    invalid(`${path.relative(repositoryRoot, filePath)} 不是合法 YAML：${document.errors[0].message}`);
  }
  const value = document.toJS({ maxAliasCount: 100 });
  if (!isRecord(value)) {
    invalid(`${path.relative(repositoryRoot, filePath)} 顶层必须是对象`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      invalid(`${label} 包含未知字段 ${field}`);
    }
  }
}

async function readCategories(rootDirectory) {
  const config = await readYaml(path.join(rootDirectory, 'categories.yml'));
  rejectUnknownFields(config, new Set(['version', 'categories']), 'categories.yml');
  if (config.version !== 1) {
    invalid('categories.yml 的 version 必须为 1');
  }
  if (!Array.isArray(config.categories) || config.categories.length === 0 || config.categories.length > 50) {
    invalid('categories.yml 必须声明 1 到 50 个分类');
  }
  const seen = new Set();
  return config.categories.map((category, index) => {
    const label = `第 ${index + 1} 个分类`;
    if (!isRecord(category)) {
      invalid(`${label} 必须是对象`);
    }
    rejectUnknownFields(category, allowedCategoryFields, label);
    const id = identifier(category.id, `${label}.id`);
    if (seen.has(id)) {
      invalid(`分类 ID 重复：${id}`);
    }
    seen.add(id);
    const result = {
      id,
      name: text(category.name, `${label}.name`, 40),
      description: category.description === undefined ? '' : text(category.description, `${label}.description`, 160),
      count: 0,
    };
    return result;
  });
}

function isWithinDirectory(rootDirectory, targetPath) {
  const relative = path.relative(rootDirectory, targetPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function hasImageSignature(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const png = bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const webp = bytesRead >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
    return png || jpeg || webp;
  } finally {
    await handle.close();
  }
}

function portablePathSegment(segment, field) {
  if (!segment || segment === '.' || segment === '..' || /[<>:"\\|?*\u0000-\u001f]/.test(segment) || /[ .]$/.test(segment)) {
    invalid(`${field} 包含不能跨平台使用的路径片段`);
  }
  const basename = segment.split('.')[0];
  if (windowsReservedNamePattern.test(basename)) {
    invalid(`${field} 不能使用 Windows 保留文件名`);
  }
}

async function validateIcon(rootDirectory, icon, resourceLabel) {
  const normalized = path.posix.normalize(icon.replaceAll('\\', '/'));
  if (normalized !== icon || normalized.includes('%') || !normalized.startsWith('assets/icons/') || normalized.includes('/../')) {
    invalid(`${resourceLabel}.icon 必须指向 assets/icons/ 内的仓库文件`);
  }
  if (!allowedIconExtensions.has(path.posix.extname(normalized).toLowerCase())) {
    invalid(`${resourceLabel}.icon 只支持 PNG、JPG、JPEG 或 WebP`);
  }
  for (const segment of normalized.split('/').slice(2)) {
    portablePathSegment(segment, `${resourceLabel}.icon`);
  }
  const iconPath = path.join(rootDirectory, ...normalized.split('/'));
  const iconsRoot = path.join(rootDirectory, 'assets', 'icons');
  let stat;
  let realRoot;
  let realIconsRoot;
  let realIconPath;
  try {
    realRoot = await fs.realpath(rootDirectory);
    realIconsRoot = await fs.realpath(iconsRoot);
    stat = await fs.lstat(iconPath);
    if (!stat.isSymbolicLink()) {
      realIconPath = await fs.realpath(iconPath);
    }
  } catch {
    invalid(`${resourceLabel}.icon 指向的文件不存在：${normalized}`);
  }
  if (stat.isSymbolicLink() || !isWithinDirectory(realRoot, realIconsRoot) || !isWithinDirectory(realIconsRoot, realIconPath)) {
    invalid(`${resourceLabel}.icon 不能使用符号链接或指向仓库外文件`);
  }
  const realStat = await fs.stat(realIconPath);
  if (!realStat.isFile() || realStat.size > maximumIconBytes) {
    invalid(`${resourceLabel}.icon 必须是小于等于 512 KiB 的文件`);
  }
  if (!await hasImageSignature(realIconPath)) {
    invalid(`${resourceLabel}.icon 内容必须是有效的 PNG、JPG 或 WebP 图片`);
  }
  return normalized;
}

async function readResource(rootDirectory, category, filePath) {
  const id = path.basename(filePath, path.extname(filePath));
  identifier(id, `${category.id} 分类中的文件名`);
  const label = `${category.id}/${id}`;
  const resource = await readYaml(filePath);
  rejectUnknownFields(resource, allowedResourceFields, label);
  const url = text(resource.url, `${label}.url`, 2048);
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) {
    invalid(`${label}.url 不能包含空白、控制字符或反斜杠`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid(`${label}.url 不是合法网址`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    invalid(`${label}.url 必须是且只能是 HTTPS 网址，不能包含账号或密码`);
  }
  const normalizedURL = parsed.href;
  if (Buffer.byteLength(normalizedURL, 'utf8') > 2048) {
    invalid(`${label}.url 规范化后不能超过 2048 字节`);
  }
  let tags = [];
  if (resource.tags !== undefined) {
    if (!Array.isArray(resource.tags) || resource.tags.length > 8) {
      invalid(`${label}.tags 最多包含 8 个标签`);
    }
    const seen = new Set();
    tags = resource.tags.map((tag, index) => {
      const normalized = text(tag, `${label}.tags[${index}]`, 24);
      if (seen.has(normalized)) {
        invalid(`${label}.tags 包含重复标签：${normalized}`);
      }
      seen.add(normalized);
      return normalized;
    });
  }
  const icon = resource.icon === undefined ? '' : await validateIcon(rootDirectory, text(resource.icon, `${label}.icon`, 240), label);
  return {
    id,
    category: category.id,
    name: text(resource.name, `${label}.name`, 80),
    url: normalizedURL,
    description: text(resource.description, `${label}.description`, 300),
    tags,
    icon,
  };
}

export async function buildCatalog(rootDirectory = repositoryRoot) {
  const categories = await readCategories(rootDirectory);
  const declaredCategories = new Set(categories.map(category => category.id));
  const dataDirectory = path.join(rootDirectory, 'data');
  let dataEntries;
  try {
    dataEntries = await fs.readdir(dataDirectory, { withFileTypes: true });
  } catch (error) {
    invalid(`无法读取数据目录：${error.message}`);
  }
  for (const entry of dataEntries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      invalid(`数据目录不能使用符号链接：${entry.name}`);
    }
    if (entry.isDirectory() && !declaredCategories.has(entry.name)) {
      invalid(`数据目录包含未声明的分类：${entry.name}`);
    }
    if (entry.isFile() && ['.yml', '.yaml'].includes(path.extname(entry.name).toLowerCase())) {
      invalid(`资源 YAML 必须放在已声明的分类目录中：${entry.name}`);
    }
  }
  const resources = [];
  const seenIds = new Set();
  for (const category of categories) {
    const directory = path.join(rootDirectory, 'data', category.id);
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      invalid(`无法读取分类目录 ${category.id}：${error.message}`);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        invalid(`${category.id} 分类不能使用符号链接：${entry.name}`);
      }
      if (entry.isDirectory()) {
        invalid(`${category.id} 分类不能包含子目录：${entry.name}`);
      }
      if (!entry.isFile() || entry.name.startsWith('.') || !['.yml', '.yaml'].includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const resource = await readResource(rootDirectory, category, path.join(directory, entry.name));
      if (seenIds.has(resource.id)) {
        invalid(`资源 ID 重复：${resource.id}`);
      }
      seenIds.add(resource.id);
      resources.push(resource);
      category.count += 1;
      if (resources.length > maximumResources) {
        invalid(`资源总数不能超过 ${maximumResources}`);
      }
    }
  }
  resources.sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id));
  return {
    schema_version: 1,
    categories,
    resources,
  };
}

function markdownText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('`', '\\`')
    .replaceAll('~', '\\~')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function markdownDestination(value) {
  return new URL(value).href.replaceAll('(', '%28').replaceAll(')', '%29').replaceAll('[', '%5B').replaceAll(']', '%5D');
}

export function renderReadme(catalog) {
  const lines = [
    '# 格式匠研究资源',
    '',
    '格式匠「研究资源」页面的公开数据源。内容由官方维护，YAML 是唯一数据源，`catalog.json` 与本文件由脚本生成。',
    '',
    '## 分类',
    '',
  ];
  for (const category of catalog.categories) {
    lines.push(`- **${markdownText(category.name)}**：${markdownText(category.description || '暂无简介')}（${category.count} 条）`);
  }
  lines.push('', '## 资源列表', '');
  for (const category of catalog.categories) {
    lines.push(`### ${markdownText(category.name)}`, '');
    const items = catalog.resources.filter((resource) => resource.category === category.id);
    if (items.length === 0) {
      lines.push('暂无资源，等待维护者补充。', '');
      continue;
    }
    for (const resource of items) {
      lines.push(`- [${markdownText(resource.name)}](${markdownDestination(resource.url)}) - ${markdownText(resource.description)}`);
    }
    lines.push('');
  }
  lines.push('---', '', '维护方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。', '');
  return lines.join('\n');
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTemporaryFile(targetPath, content) {
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
    return temporaryPath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function readLockOwner(lockPath) {
  try {
    const content = await fs.readFile(lockPath, 'utf8');
    const value = JSON.parse(content);
    return Number.isInteger(value.pid) && value.pid > 0 ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function acquireOutputLock(rootDirectory) {
  const lockPath = path.join(rootDirectory, '.catalog-write.lock');
  const token = randomUUID();
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readLockOwner(lockPath);
        if (current?.token === token) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      const owner = await readLockOwner(lockPath);
      if (owner === undefined) continue;
      if (owner && !processExists(owner.pid)) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        invalid('生成文件锁无法确认持有进程，请检查 .catalog-write.lock 后重试');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function writeOutputs(rootDirectory = repositoryRoot) {
  const catalog = await buildCatalog(rootDirectory);
  const outputs = [
    { target: path.join(rootDirectory, 'catalog.json'), content: `${JSON.stringify(catalog, null, 2)}\n` },
    { target: path.join(rootDirectory, 'README.md'), content: renderReadme(catalog) },
  ];
  const releaseLock = await acquireOutputLock(rootDirectory);
  try {
    const previous = await Promise.all(outputs.map(output => readOptionalFile(output.target)));
    const temporaryPaths = [];
    const replaced = [];
    try {
      for (const output of outputs) {
        temporaryPaths.push(await writeTemporaryFile(output.target, output.content));
      }
      for (let index = 0; index < outputs.length; index += 1) {
        await fs.rename(temporaryPaths[index], outputs[index].target);
        temporaryPaths[index] = '';
        replaced.push(index);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const index of replaced.reverse()) {
        try {
          if (previous[index] === null) {
            await fs.rm(outputs[index].target, { force: true });
            continue;
          }
          const rollbackPath = await writeTemporaryFile(outputs[index].target, previous[index]);
          try {
            await fs.rename(rollbackPath, outputs[index].target);
          } catch (rollbackError) {
            await fs.rm(rollbackPath, { force: true }).catch(() => {});
            throw rollbackError;
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      await Promise.all(temporaryPaths.filter(Boolean).map(temporaryPath => fs.rm(temporaryPath, { force: true }).catch(() => {})));
      if (rollbackErrors.length > 0) {
        invalid('生成文件写入失败，且旧文件回滚失败，请检查 catalog.json 与 README.md');
      }
      throw error;
    }
    return catalog;
  } finally {
    await releaseLock();
  }
}

export async function checkOutputs(rootDirectory = repositoryRoot) {
  const catalog = await buildCatalog(rootDirectory);
  const expectedCatalog = `${JSON.stringify(catalog, null, 2)}\n`;
  const expectedReadme = renderReadme(catalog);
  const [actualCatalog, actualReadme] = await Promise.all([
    fs.readFile(path.join(rootDirectory, 'catalog.json'), 'utf8'),
    fs.readFile(path.join(rootDirectory, 'README.md'), 'utf8'),
  ]);
  if (actualCatalog !== expectedCatalog) {
    invalid('catalog.json 与 YAML 数据源不一致，请运行 npm run build');
  }
  if (actualReadme !== expectedReadme) {
    invalid('README.md 与 YAML 数据源不一致，请运行 npm run build');
  }
  return catalog;
}

async function runCli() {
  const positionalArguments = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const rootDirectory = positionalArguments[0] ? path.resolve(positionalArguments[0]) : repositoryRoot;
  if (process.argv.includes('--check')) {
    const catalog = await checkOutputs(rootDirectory);
    process.stdout.write(`校验通过：${catalog.categories.length} 个分类，${catalog.resources.length} 条资源。\n`);
    return;
  }
  const catalog = await writeOutputs(rootDirectory);
  process.stdout.write(`已生成：${catalog.categories.length} 个分类，${catalog.resources.length} 条资源。\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
