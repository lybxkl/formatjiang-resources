# 研究资源数据

每个分类目录下，一个资源对应一个 `.yml` 文件。文件名就是资源 ID，只使用小写字母、数字和连字符。

必填字段：

```yaml
name: 资源名称
url: https://example.com/
description: 一句话说明这个资源适合解决什么问题。
```

可选字段：

```yaml
tags:
  - 标签一
  - 标签二
icon: assets/icons/example.png
```

图标只接受仓库内的 PNG、JPG、JPEG 或 WebP 文件，单张不超过 512 KiB。分类和顺序由根目录 `categories.yml` 维护。

修改数据后运行：

```bash
npm ci
npm run build
npm test
```

`catalog.json` 与 `README.md` 由脚本生成，不要手工编辑。GitHub Actions 仅提供手动触发的校验与重建入口。
