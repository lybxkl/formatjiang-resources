import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedResourceFields = new Set(['name', 'url', 'description', 'tags', 'icon']);
const allowedCategoryFields = new Set(['id', 'name', 'description']);
const allowedIconExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const maximumIconBytes = 512 * 1024;
const maximumResources = 2000;

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
  return result;
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

async function validateIcon(rootDirectory, icon, resourceLabel) {
  const normalized = path.posix.normalize(icon.replaceAll('\\', '/'));
  if (normalized !== icon || !normalized.startsWith('assets/icons/') || normalized.includes('/../')) {
    invalid(`${resourceLabel}.icon 必须指向 assets/icons/ 内的仓库文件`);
  }
  if (!allowedIconExtensions.has(path.posix.extname(normalized).toLowerCase())) {
    invalid(`${resourceLabel}.icon 只支持 PNG、JPG、JPEG 或 WebP`);
  }
  const iconPath = path.join(rootDirectory, ...normalized.split('/'));
  let stat;
  try {
    stat = await fs.stat(iconPath);
  } catch {
    invalid(`${resourceLabel}.icon 指向的文件不存在：${normalized}`);
  }
  if (!stat.isFile() || stat.size > maximumIconBytes) {
    invalid(`${resourceLabel}.icon 必须是小于等于 512 KiB 的文件`);
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
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    invalid(`${label}.url 不是合法网址`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    invalid(`${label}.url 必须是且只能是 HTTPS 网址，不能包含账号或密码`);
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
    url,
    description: text(resource.description, `${label}.description`, 300),
    tags,
    icon,
  };
}

export async function buildCatalog(rootDirectory = repositoryRoot) {
  const categories = await readCategories(rootDirectory);
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
  resources.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id));
  return {
    schema_version: 1,
    categories,
    resources,
  };
}

function markdownText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\r', ' ').replaceAll('\n', ' ');
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
      lines.push(`- [${markdownText(resource.name)}](${resource.url}) - ${markdownText(resource.description)}`);
    }
    lines.push('');
  }
  lines.push('---', '', '维护方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。', '');
  return lines.join('\n');
}

export async function writeOutputs(rootDirectory = repositoryRoot) {
  const catalog = await buildCatalog(rootDirectory);
  await Promise.all([
    fs.writeFile(path.join(rootDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(rootDirectory, 'README.md'), renderReadme(catalog), 'utf8'),
  ]);
  return catalog;
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
