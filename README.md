# Office Document Translator

本地运行的 AI Office 文档翻译工作台：导入 Office 文件，完成上下文翻译、术语治理、人工审校，并生成尽量保留原格式的译文文件。

**第一次翻得准，长期用得稳。** 目前支持 PPTX、DOCX、XLSX，以及中文、英语、法语、日语、意大利语和阿拉伯语等翻译方向。

> 社区版在用户电脑上解析和生成原始文件，没有托管版的商业文件大小限制。实际处理能力取决于本机内存、磁盘和模型服务限制。

## 交给 Agent 安装

把下面整段复制给 Codex、Claude Code、Cursor 等可以操作终端的编程 Agent：

```text
请在我的电脑上安装并验证 Office Document Translator：
https://github.com/XinCMa/office-document-translator

要求：
1. 检查 Node.js，必须为 22 或更高版本；缺少时先告诉我，不要擅自修改系统环境。
2. 克隆仓库，使用 npm ci 安装锁定依赖。
3. 如果 .env 不存在，从 .env.example 复制一份。
4. 不要读取、打印或提交我的 API Key；请让我亲自在 .env 中填写 DEEPSEEK_API_KEY。
5. 运行 npm run check，一次完成类型检查、测试和生产构建。
6. 使用 npm run dev 启动，确认 http://127.0.0.1:8080/ 返回 200，且
   /api/system/config 的 hasDeepseekKey 为 true。
7. 默认保持 HOST=127.0.0.1，不要部署到公网，也不要删除或覆盖已有 data/ 数据。
8. 如果 8080 端口被占用，先告诉我占用进程，不要直接结束它。
9. 完成后只需告诉我本地地址、验证结果和停止服务的方法。
```

Agent 无法代替你安全地填写密钥；它准备好 `.env` 后，在文件中填入：

```dotenv
DEEPSEEK_API_KEY=your_api_key_here
```

## 自己安装：3 分钟启动

要求：

- macOS、Windows 或 Linux
- Node.js 22+
- DeepSeek API Key

```bash
git clone https://github.com/XinCMa/office-document-translator.git
cd office-document-translator
cp .env.example .env
npm ci
npm run dev
```

Windows PowerShell 请将复制配置文件的命令替换为：

```powershell
Copy-Item .env.example .env
```

编辑 `.env` 填入 `DEEPSEEK_API_KEY`，然后打开 [http://localhost:8080](http://localhost:8080)。终端显示以下内容即表示服务已启动：

```text
Server fully operational on http://localhost:8080
```

停止服务：回到运行服务的终端，按 `Control + C`。

## 配置

`.env` 已被 Git 忽略，请勿提交真实密钥。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 无 | 你自己的模型 API Key |
| `DEEPSEEK_API_BASE` | 否 | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | 使用的模型名称 |
| `TRANSLATION_CONCURRENCY` | 否 | `6` | 同时处理的请求批次，限制为 1–12 |
| `HOST` | 否 | `127.0.0.1` | 服务监听地址；本地使用请保持默认 |
| `PORT` | 否 | `8080` | 本地端口 |
| `DATA_DIR` | 否 | `./data` | 项目、术语库和翻译记忆目录 |

提高并发不一定始终更快。若模型服务频繁返回 429，可将 `TRANSLATION_CONCURRENCY` 调低；程序重试时会优先遵循服务商返回的 `Retry-After`。

## 如何验证安装

一条命令完成类型检查、4 组测试和生产构建：

```bash
npm run check
```

启动后检查配置接口：

```bash
curl http://127.0.0.1:8080/api/system/config
```

返回内容中的 `hasDeepseekKey` 应为 `true`。最后用一个不含敏感信息的小型 PPTX、DOCX 或 XLSX 完成：

```text
导入 → 确认语言与术语 → 翻译 → 审校 → 生成并打开文件
```

## 主要能力

- PPTX、DOCX、XLSX 文本提取与格式保留生成
- 基于全文与段落位置的上下文翻译
- 自动检测源语言和推荐项目术语
- 多套个人术语库、语言方向、优先级和术语冲突处理
- 翻译暂停、继续和局部增量重翻
- 逐条人工审校、术语校验和翻译记忆
- 没有现成术语库时，也以首次翻译可用性为目标

## 为什么不是普通聊天翻译

- 相比通用 Agent：它交付可继续编辑的 Office 文件，而不只是聊天窗口中的译文。
- 相比传统 CAT：没有预建术语库也能快速开始，并自动从当前文档发现术语。
- 相比通用机器翻译：术语、上下文、人工修改和最终文件生成处于同一条工作流。

复杂图表、嵌入对象、特殊字体和极端版式仍可能需要人工复核。正式交付前请检查译文与排版。

## 本地数据与隐私边界

- Office 原始文件由本机 Node.js 服务解析和重新生成，不会上传给本项目运营方。
- 翻译时，提取出的文本、上下文及相关术语会发送给你配置的模型服务商。
- 项目、术语库和翻译记忆保存在 `data/`，处理中的临时文件位于 `uploads/`。
- `.env`、`data/`、`uploads/`、`dist/` 和 `node_modules/` 均被 Git 忽略。
- 清除本地数据前请停止服务；删除 `data/` 会同时删除项目、术语库和翻译记忆。

## 生产模式

```bash
npm run build
npm start
```

社区版设计为单机本地工具，默认只监听 `127.0.0.1:8080`。它没有公网服务所需的账号系统、访问控制、租户隔离、滥用防护和运维能力，因此不要直接将端口暴露到公网。

## 常见问题

### `EADDRINUSE: port 8080`

8080 端口已被其他进程占用。macOS/Linux 可先检查：

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

确认旧服务可以停止后结束它，或者在 `.env` 中改用其他端口，例如 `PORT=8081`。

### 页面提示没有配置 API Key

确认文件名是 `.env` 而不是 `.env.txt`，填写 `DEEPSEEK_API_KEY` 后重启服务。

### 大文件翻译很慢或出现 429

大文件会拆分成多个批次持续处理。先降低 `TRANSLATION_CONCURRENCY`，并检查模型账户余额、RPM/TPM 配额与上下文限制。

## 项目结构

```text
server.ts          本地 HTTP 服务与翻译工作流
server/            Office 解析、生成、术语、翻译和本地数据层
src/               React 用户界面
data/              本地项目与术语数据（运行后创建，不提交）
uploads/           临时处理文件（运行后创建，不提交）
.env.example       本地配置模板
```

## 贡献

欢迎提交 Issue 和 Pull Request。报告文档兼容问题时，请提供不含敏感信息的最小复现文件，并说明操作系统、Node.js 版本、文件格式和复现步骤。

## License

本项目采用 [GNU Affero General Public License v3.0](LICENSE)。如果你修改本项目并通过网络向用户提供服务，需要按许可证要求向相应用户提供修改后的源代码。
