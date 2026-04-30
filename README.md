# 🐾 Pet Agent

> 毛孩子健康顾问 — 基于 MiniMax LLM 的宠物健康 AI 助手，支持 CLI / MCP / TUI 三种运行模式

```
npm install -g pet-agent
petagent tui            # 进入对话
petagent --help         # 查看全部命令
```

## 三种运行模式

| 模式 | 命令 | 说明 |
|------|------|------|
| **CLI** | `petagent tui` | 命令行对话，专注快速问答 |
| **TUI** | `petagent tui` | 键盘导航的终端界面 |
| **MCP** | `petagent mcp` | 作为 MCP Server 接入 VSCode / Cursor |

## 核心能力

```
🐾 宠物健康初筛     — 症状分析 + 紧急度判断 + 就医建议
🔍 多层记忆系统     — 用户画像 / 领域知识 / 会话摘要 / 检索记忆
📚 Session 管理     — SQLite 持久化 + 摘要压缩 + FTS 全文检索
🛠️ 工具调用         — 宠物图片分析 / 药品真伪查询 / 联网搜索
🔌 MCP 协议        — 接入 AI IDE，作为编程助手使用
```

## 快速开始

```bash
# 安装
git clone https://github.com/your-org/pet-agent-ts.git
cd pet-agent-ts
npm install && npm run build

# 配置
cp .env.example .env
# 填入 MINIMAX_API_KEY

# 对话
petagent tui

# TUI 模式
petagent tui

# MCP 模式（接入 VSCode）
petagent mcp
```

## 架构总览

```
src/
├── agent/           # Agent 核心：prompt 构造、memory 格式编排
├── cli/             # CLI 入口 + 命令解析
├── core/            # MCP 协议实现、Skill 注册机制
├── home/            # 用户工作区（SOUL/MEMORY/USER）初始化
├── llm/             # LLM 调用封装（支持 MiniMax / OpenAI / Anthropic）
├── memory/          # 分层记忆系统
│   └── layered/     #   - user_profile / domain_context / session_summary / retrieval
├── model_manager/   # 多模型路由与降级策略
├── runtime/         # 工具运行时 + ToolManager
├── session/         # Session 管理
│   ├── SQLiteSessionStore   # SQLite 持久化
│   ├── SessionCompressor    # 自动摘要压缩
│   ├── SessionSearch        # FTS 全文检索
│   └── SessionRouter        # 多会话路由
├── action/          # 工具调用审计日志
├── artifacts/       # 大型结果（图片/报告）存储
└── tools/           # 内置工具注册
```

## Session 持久化

```bash
~/.PetAgent/agents/<agent>/sessions/session.sqlite
```

支持 FTS5 全文搜索，自动摘要压缩（每 N 轮触发），超过 30 天的旧会话自动清理原始消息但保留摘要。

## 分层记忆

| 层级 | 文件 | 用途 | 更新频率 |
|------|------|------|---------|
| 用户画像 | `user_profile.json` | 宠物种类、年龄、主人口偏好 | 低 |
| 领域知识 | `domain_context.md` | 垂直业务规则、用药安全边界 | 低 |
| 会话摘要 | `session_summary.md` | 当前会话关键点 | 中 |
| 检索记忆 | `retrieval_memory.jsonl` | 长期经验和历史案例 | 按需 |

## CLI 命令

```bash
petagent tui [options]       # 进入对话
  --model <name>    指定模型（minimax / openai / claude）
  --session <id>    指定会话 ID

petagent tui               # TUI 界面

petagent mcp [options]     # 启动 MCP Server
  --port <port>    监听端口（默认 3100）
  --stdio          以 stdio 模式运行（用于 IDE 集成）

petagent memory <cmd>       # 记忆管理
  search <query>    搜索历史记忆
  list             列出所有会话

petagent session <cmd>      # 会话管理
  list             列出所有会话
  export <id>      导出会话记录
```

## 环境变量

```env
MINIMAX_API_KEY=      # MiniMax API Key（主要 LLM）
OPENAI_API_KEY=       # OpenAI API Key（备用）
ANTHROPIC_API_KEY=    # Anthropic API Key（备用）
LOG_LEVEL=info        # 日志级别：debug / info / warn / error
DATA_DIR=~/.PetAgent   # 数据目录
```

## License

MIT
