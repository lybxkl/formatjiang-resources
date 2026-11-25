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

async function writeResource(rootDirectory, body) {
  await fs.writeFile(path.join(rootDirectory, 'data', 'learning', 'example.yml'), body);
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
