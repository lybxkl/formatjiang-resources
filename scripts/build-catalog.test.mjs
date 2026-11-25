import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCatalog, checkOutputs, renderReadme, writeOutputs } from './build-catalog.mjs';

async function fixture(t) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'formatjiang-resources-'));
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDirectory, 'data', 'learning'), { recursive: true });
  await fs.mkdir(path.join(rootDirectory, 'assets', 'icons'), { recursive: true });
  await fs.writeFile(path.join(rootDirectory, 'categories.yml'), [
    'version: 1',
    'categories:',
    '  - id: learning',
    '    name: 学习资源',
    '    description: 课程与教程。',
    '',
  ].join('\n'));
  return rootDirectory;
}

async function writeResourceFile(rootDirectory, category, filename, body) {
  await fs.writeFile(path.join(rootDirectory, 'data', category, filename), body);
}

async function writeResource(rootDirectory, body) {
  await writeResourceFile(rootDirectory, 'learning', 'example.yml', body);
}

test('生成稳定目录与 README', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, [
    'name: 示例课程',
    'url: https://example.com/course',
    'description: 用于验证目录生成。',
    'tags:',
    '  - 课程',
    '',
  ].join('\n'));
  const catalog = await buildCatalog(rootDirectory);
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.categories[0].count, 1);
  assert.equal(catalog.resources[0].id, 'example');
  assert.match(renderReadme(catalog), /\[示例课程\]\(https:\/\/example\.com\/course\)/);
  await writeOutputs(rootDirectory);
  await checkOutputs(rootDirectory);
});

test('拒绝缺失必填字段', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\n');
  await assert.rejects(buildCatalog(rootDirectory), /description 必须是非空字符串/);
});

test('拒绝非 HTTPS 网址', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: http://example.com/\ndescription: 示例。\n');
  await assert.rejects(buildCatalog(rootDirectory), /HTTPS/);
});

test('拒绝全库重复资源 ID', async (t) => {
  const rootDirectory = await fixture(t);
  await fs.writeFile(path.join(rootDirectory, 'categories.yml'), [
    'version: 1',
    'categories:',
    '  - id: learning',
    '    name: 学习资源',
    '  - id: tools',
    '    name: 研究工具',
    '',
  ].join('\n'));
  await fs.mkdir(path.join(rootDirectory, 'data', 'tools'), { recursive: true });
  const body = 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n';
  await writeResource(rootDirectory, body);
  await fs.writeFile(path.join(rootDirectory, 'data', 'tools', 'example.yml'), body);
  await assert.rejects(buildCatalog(rootDirectory), /资源 ID 重复/);
});

test('拒绝仓库外图标', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\nicon: ../outside.png\n');
  await assert.rejects(buildCatalog(rootDirectory), /assets\/icons/);
});

test('拒绝未知分类与错位资源', async (t) => {
  const rootDirectory = await fixture(t);
  await fs.mkdir(path.join(rootDirectory, 'data', 'typo'));
  await assert.rejects(buildCatalog(rootDirectory), /未声明的分类/);
  await fs.rm(path.join(rootDirectory, 'data', 'typo'), { recursive: true });
  await fs.writeFile(path.join(rootDirectory, 'data', 'root.yml'), 'name: 错位资源\n');
  await assert.rejects(buildCatalog(rootDirectory), /必须放在已声明的分类目录/);
});

test('拒绝 Windows 保留文件名', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResourceFile(rootDirectory, 'learning', 'con.yml', 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  await assert.rejects(buildCatalog(rootDirectory), /Windows 保留文件名/);
});

test('拒绝含空白或控制字符的网址', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: "https://example.com/\\n[伪造](https://evil.example)"\ndescription: 示例。\n');
  await assert.rejects(buildCatalog(rootDirectory), /不能包含空白/);
});

test('Markdown 链接目的地会转义括号', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/a(b)\ndescription: 示例。\n');
  const catalog = await buildCatalog(rootDirectory);
  assert.match(renderReadme(catalog), /https:\/\/example\.com\/a%28b%29/);
});

test('资源排序不依赖系统语言环境', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResourceFile(rootDirectory, 'learning', 'b.yml', 'name: 资源 B\nurl: https://example.com/b\ndescription: 示例。\n');
  await writeResourceFile(rootDirectory, 'learning', 'a.yml', 'name: Asset A\nurl: https://example.com/a\ndescription: 示例。\n');
  const catalog = await buildCatalog(rootDirectory);
  assert.deepEqual(catalog.resources.map(resource => resource.name), ['Asset A', '资源 B']);
});

test('拒绝伪造图片与超限图标', async (t) => {
  const rootDirectory = await fixture(t);
  const iconPath = path.join(rootDirectory, 'assets', 'icons', 'fake.png');
  await fs.writeFile(iconPath, 'not an image');
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\nicon: assets/icons/fake.png\n');
  await assert.rejects(buildCatalog(rootDirectory), /内容必须是有效的/);
  await fs.writeFile(iconPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512 * 1024)]));
  await assert.rejects(buildCatalog(rootDirectory), /512 KiB/);
});

test('接受最小 PNG 图标签名', async (t) => {
  const rootDirectory = await fixture(t);
  await fs.writeFile(path.join(rootDirectory, 'assets', 'icons', 'valid.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\nicon: assets/icons/valid.png\n');
  const catalog = await buildCatalog(rootDirectory);
  assert.equal(catalog.resources[0].icon, 'assets/icons/valid.png');
});

test('拒绝图标符号链接', async (t) => {
  const rootDirectory = await fixture(t);
  const target = path.join(rootDirectory, 'outside.png');
  await fs.writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    await fs.symlink(target, path.join(rootDirectory, 'assets', 'icons', 'linked.png'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('当前系统未授予创建符号链接权限');
      return;
    }
    throw error;
  }
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\nicon: assets/icons/linked.png\n');
  await assert.rejects(buildCatalog(rootDirectory), /不能使用符号链接/);
});

test('资源总数上限为 2000', async (t) => {
  const rootDirectory = await fixture(t);
  const directory = path.join(rootDirectory, 'data', 'learning');
  for (let index = 0; index < 2001; index += 100) {
    const batch = [];
    for (let current = index; current < Math.min(index + 100, 2001); current += 1) {
      batch.push(fs.writeFile(path.join(directory, `resource-${current}.yml`), `name: 资源 ${current}\nurl: https://example.com/${current}\ndescription: 示例。\n`));
    }
    await Promise.all(batch);
  }
  await assert.rejects(buildCatalog(rootDirectory), /不能超过 2000/);
  await fs.rm(path.join(directory, 'resource-2000.yml'));
  const catalog = await buildCatalog(rootDirectory);
  assert.equal(catalog.resources.length, 2000);
});

test('第二个生成文件替换失败时回滚第一个文件', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  await writeOutputs(rootDirectory);
  const catalogPath = path.join(rootDirectory, 'catalog.json');
  const readmePath = path.join(rootDirectory, 'README.md');
  const previousCatalog = await fs.readFile(catalogPath, 'utf8');
  const previousReadme = await fs.readFile(readmePath, 'utf8');
  const originalRename = fs.rename;
  let renameCalls = 0;
  fs.rename = async (from, to) => {
    renameCalls += 1;
    if (renameCalls === 2) throw new Error('simulated rename failure');
    return originalRename(from, to);
  };
  t.after(() => { fs.rename = originalRename; });
  await writeResourceFile(rootDirectory, 'learning', 'second.yml', 'name: 第二项\nurl: https://example.com/second\ndescription: 示例。\n');
  await assert.rejects(writeOutputs(rootDirectory), /simulated rename failure/);
  assert.equal(await fs.readFile(catalogPath, 'utf8'), previousCatalog);
  assert.equal(await fs.readFile(readmePath, 'utf8'), previousReadme);
  const temporaryFiles = (await fs.readdir(rootDirectory)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(temporaryFiles, []);
});

test('Actions 仅手动触发且写权限限于提交作业', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/validate-resources.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request):/m);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /update:[\s\S]*?permissions:\n      contents: write/);
});

test('拒绝分类子目录中的资源', async (t) => {
  const rootDirectory = await fixture(t);
  const nested = path.join(rootDirectory, 'data', 'learning', 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'hidden.yml'), 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  await assert.rejects(buildCatalog(rootDirectory), /不能包含子目录/);
});

test('拒绝不能跨平台检出的图标路径', async (t) => {
  const rootDirectory = await fixture(t);
  for (const icon of ['assets/icons/con.png', 'assets/icons/bad:name.png']) {
    await writeResource(rootDirectory, `name: 示例\nurl: https://example.com/\ndescription: 示例。\nicon: ${icon}\n`);
    await assert.rejects(buildCatalog(rootDirectory), /Windows|跨平台/);
  }
});

test('README 文本转义 HTML 与 Markdown 元字符', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: "<a href=\\"https://evil.example\\">危险</a>"\nurl: https://example.com/\ndescription: "*说明*"\n');
  const catalog = await buildCatalog(rootDirectory);
  const readme = renderReadme(catalog);
  assert.doesNotMatch(readme, /<a href=/);
  assert.match(readme, /&lt;a href=/);
  assert.match(readme, /\\\*说明\\\*/);
});

test('资源排序按 Unicode 码点比较', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResourceFile(rootDirectory, 'learning', 'supplementary.yml', 'name: "\u{10000}"\nurl: https://example.com/a\ndescription: 示例。\n');
  await writeResourceFile(rootDirectory, 'learning', 'private.yml', 'name: "\u{E000}"\nurl: https://example.com/b\ndescription: 示例。\n');
  const catalog = await buildCatalog(rootDirectory);
  assert.deepEqual(catalog.resources.map(resource => resource.id), ['private', 'supplementary']);
});

test('并发写入按仓库锁串行且保持双文件一致', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  await writeOutputs(rootDirectory);
  const originalRename = fs.rename;
  let renameCalls = 0;
  let markSecondRename;
  let releaseSecondRename;
  const secondRenameStarted = new Promise(resolve => { markSecondRename = resolve; });
  const secondRenameGate = new Promise(resolve => { releaseSecondRename = resolve; });
  fs.rename = async (from, to) => {
    renameCalls += 1;
    if (renameCalls === 2) {
      markSecondRename();
      await secondRenameGate;
    }
    return originalRename(from, to);
  };
  t.after(() => {
    releaseSecondRename?.();
    fs.rename = originalRename;
  });
  const firstWrite = writeOutputs(rootDirectory);
  await secondRenameStarted;
  await writeResourceFile(rootDirectory, 'learning', 'second.yml', 'name: 第二项\nurl: https://example.com/second\ndescription: 示例。\n');
  const secondWrite = writeOutputs(rootDirectory);
  releaseSecondRename();
  await Promise.all([firstWrite, secondWrite]);
  await checkOutputs(rootDirectory);
  await assert.rejects(fs.stat(path.join(rootDirectory, '.catalog-write.lock')), { code: 'ENOENT' });
});

test('拒绝反斜杠网址并统一输出规范化网址', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com\\@evil.example/\ndescription: 示例。\n');
  await assert.rejects(buildCatalog(rootDirectory), /反斜杠/);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com\ndescription: 示例。\n');
  const catalog = await buildCatalog(rootDirectory);
  assert.equal(catalog.resources[0].url, 'https://example.com/');
});

test('拒绝规范化后超过桌面端字节上限的网址', async (t) => {
  const rootDirectory = await fixture(t);
  const longURL = `https://example.com/${'汉'.repeat(700)}`;
  await writeResource(rootDirectory, `name: 示例\nurl: ${longURL}\ndescription: 示例。\n`);
  await assert.rejects(buildCatalog(rootDirectory), /2048 字节/);
});

test('活动进程的旧锁不会被超时强抢', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  const lockPath = path.join(rootDirectory, '.catalog-write.lock');
  await fs.writeFile(lockPath, JSON.stringify({ token: 'active-owner', pid: process.pid, createdAt: new Date(0).toISOString() }));
  const oldTime = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, oldTime, oldTime);
  const writing = writeOutputs(rootDirectory);
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.stat(lockPath);
  } finally {
    await fs.rm(lockPath, { force: true });
    await writing;
  }
  await checkOutputs(rootDirectory);
});

test('持有进程已退出的锁可以安全清理', async (t) => {
  const rootDirectory = await fixture(t);
  await writeResource(rootDirectory, 'name: 示例\nurl: https://example.com/\ndescription: 示例。\n');
  const lockPath = path.join(rootDirectory, '.catalog-write.lock');
  await fs.writeFile(lockPath, JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647, createdAt: new Date(0).toISOString() }));
  await writeOutputs(rootDirectory);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  await checkOutputs(rootDirectory);
});
