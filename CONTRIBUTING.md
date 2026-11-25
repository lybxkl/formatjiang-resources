# 贡献指南

本仓库是格式匠「研究资源」页面的唯一数据源，采用公开可读、官方维护的方式。欢迎提交有价值的修正，但第一版只由维护者合并内容。

## 新增或修改资源

1. 在 `data/<分类>/` 下新建或修改一个 YAML 文件。
2. 文件名使用小写字母、数字和连字符，例如 `cnki.yml`。
3. 填写 `name`、`url`、`description`，按需添加 `tags` 和仓库内图标。
4. 运行 `npm ci`、`npm run build`、`npm test`。
5. 一起提交 YAML、`catalog.json` 和 `README.md`。

## 校验规则

- 分类必须已在 `categories.yml` 中声明。
- 资源 ID 全库唯一。
- 资源网址必须是 HTTPS，且不能包含账号或密码。
- 图标必须位于 `assets/icons/`，只接受 PNG、JPG、JPEG、WebP。
- 描述只写实际用途，不使用营销措辞。

## 手动 Actions

仓库提供手动触发的校验工作流。只有主动运行时才会使用 Actions 额度；日常维护以本地脚本为准。
