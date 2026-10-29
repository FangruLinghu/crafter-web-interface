# HTTP API v0.1

所有 API 与页面同源。成功返回 JSON；文件接口直接返回文件。错误格式为 `{"error":{"message":"…"}}`。状态可为 Queued、Parsing、Running Crafter、Completed、Failed。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/health` | 服务可达性与集成就绪信息 |
| GET | `/api/config` | 可见模型列表、容量设置、演示/接入说明；不返回服务凭据 |
| GET | `/api/tasks` | `{tasks:[...]}` 共享历史，最近提交优先 |
| POST | `/api/tasks` | multipart 上传，成功 201 `{task:...}` |
| GET | `/api/tasks/:id` | `{task:...}` |
| GET | `/api/tasks/:id/logs` | `{text,truncated}` 有界历史日志，前端每 2 秒获取 |
| GET | `/api/tasks/:id/pdf` | 内联查看原 PDF；`?download=1` 下载 |
| GET | `/api/tasks/:id/outputs` | `{files:[{path,size,previewable}],partial}`，仅结束后 |
| GET | `/api/tasks/:id/preview?path=...` | `{text,truncated}`；安全文本预览 |
| GET | `/api/tasks/:id/file?path=...` | 下载指定已发布文件 |
| GET | `/api/tasks/:id/archive.zip` | 按需生成全部已发布文件 ZIP |
| POST | `/api/tasks/:id/rerun` | JSON 模型设置，独立复制原 PDF，成功 201 |
| DELETE | `/api/tasks/:id` | JSON `{"confirmed":true}`，撤回排队任务或删除结束任务 |

`POST /api/tasks` 的唯一文件字段为 `paper`。远程字段：`mode=remote`、`baseUrl`、`model`、`apiKey`；本地字段：`mode=local`、`localModelId`。重跑使用相同的模型字段，不提交文件。远程重跑必须重新提供 key。

Task 字段：`id,paperName,pdfBytes,mode,baseUrl,model,localModelId,status,createdAt,startedAt,finishedAt,error,waitReason,rerunOf,withdrawn,failedStage`。`failedStage` 仅在任务失败时有值，记录失败前所处阶段（`Queued`、`Parsing` 或 `Running Crafter`），升级前失败的旧任务为 `null`。没有 API key 字段；进程组标识不对外返回。时间为 ISO-8601 UTC。

中断前未完成输出保护检查时，outputs 返回空数组和 `unavailableReason`；下载/预览返回 409。失败任务中已检查的输出保留并标记 partial。内部 work 目录没有公开接口。

常见状态码：400 输入或确认缺失，403 路径/来源/主机不允许，404 不存在，409 状态冲突或并发提交，413 超出上传/ZIP 上限，415 内容类型或预览不支持，503 未完成脚本或服务凭据配置，507 存储不足。上传/重跑返回 201 表示任务已保存排队，不代表模型认证或代码生成已完成。
