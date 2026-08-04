# Office Document Translator

本地运行的 AI Office 文档翻译工作台。面向两类需求：低频、突发翻译时，尽量让第一次结果就可用；高频、稳定翻译时，通过术语库、上下文和人工审校持续保持一致。

目前支持 **PPTX、DOCX、XLSX**。原始文件在本机解析和生成，不受托管版的商业文件大小限制；实际可处理规模取决于电脑内存、磁盘及模型服务限制。

## 它解决什么问题

- 比通用 Agent 更完整：不是只返回译文，而是完成导入、上下文翻译、术语治理、逐条审校和原格式文件生成。
- 比传统 CAT 工具更快起步：没有现成术语库时，也会结合全文上下文检测和推荐术语，降低首次翻译的人工整理成本。
- 比通用机器翻译更可控：支持多术语库、项目术语、冲突处理、人工修改和翻译记忆，更适合需要交付 Office 文件的场景。
- 本机处理文件：无需把完整 Office 文件上传到本项目运营方的服务器。

## 本地运行

要求：Node.js 22 或更高版本，以及一个 DeepSeek API Key。

```bash
git clone https://github.com/XinCMa/office-document-translator.git
cd office-document-translator
cp .env.example .env
npm install
npm run dev
```

然后在浏览器打开 [http://localhost:8080](http://localhost:8080)。

编辑 `.env`，至少填写：

```dotenv
DEEPSEEK_API_KEY=your_api_key_here
```

`.env` 已被 Git 忽略，不要提交真实密钥。

翻译默认同时处理 6 个请求批次。可根据模型服务套餐和电脑环境调整 `.env` 中的
`TRANSLATION_CONCURRENCY`，有效范围为 1–12；遇到 API 429 限流时，重试会优先遵循服务商返回的 `Retry-After`。

## 构建运行

```bash
npm run build
npm start
```

默认仅监听 `127.0.0.1:8080`。不建议直接暴露到公网；本项目的社区版没有提供公网部署所需的账号、权限、限流和租户隔离能力。

## 数据与隐私

- Office 原始文件由本机 Node.js 服务解析和重新生成。
- 翻译时，提取出的文本、上下文和相关术语会发送给你在 `.env` 中配置的模型服务商。
- 项目、术语库和翻译记忆默认保存在本仓库的 `data/`；临时文件位于 `uploads/`。两者均不会被 Git 提交。
- 如需清除本地数据，请先停止服务，再删除上述目录中的内容。

## 当前能力

- PPTX、DOCX、XLSX 文本提取与格式保留生成
- 中、英、法、日、意、阿拉伯语方向选择
- 全文上下文翻译与源语言检测
- AI 术语检测、项目术语表和多套个人术语库
- 翻译暂停、继续、增量重翻和逐条人工审校
- 术语冲突处理与翻译记忆

复杂图表、嵌入对象、特殊字体和极端版式仍可能需要人工复核。请在正式交付前检查译文与排版。

## 贡献

欢迎提交 Issue 和 Pull Request。报告文档兼容问题时，请尽量提供可公开的最小复现文件，并删除敏感信息。

## License

本项目采用 [GNU Affero General Public License v3.0](LICENSE)。如果你修改本项目并通过网络向用户提供服务，需要按该许可证向相应用户提供修改后的源代码。
