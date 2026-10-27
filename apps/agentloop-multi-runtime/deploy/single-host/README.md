# agentloop-mr 单机控制器

仅用于 44 上现有的手工 Docker、SQLite 部署。宿主机服务监听
`/run/agentloop-mr-control/control.sock`，Web 通过只读目录挂载访问，
不暴露新网络端口，也不向 Web 挂载 Docker socket。

先以 root 运行 `server-operations.sh preflight <root 私有临时目录>`，
确认两个 Runtime 的镜像、挂载、模型配置和 Run 空闲状态。再运行
`install-runtime-control.sh --apply`，最后以 root 运行
`attach-web-control.py --apply` 重建 Web。安装保留原有 Runtime、Router
及其数据。运维凭证存于
`/home/baoadmin/agentloop-mr/runtime-control/operator-token`，权限 600。

网页操作使用独立的单机 helper：读取配置、读取 Skill 清单、重载、
保存模型配置及发布 Skill。写操作检查 SQLite 中的非终态 Run，先验证
候选模型配置，再备份配置并逐个重建 Runtime。失败恢复文件和旧容器。
检查空闲状态不能阻止检查后新任务进入，执行写操作前仍须暂停新任务。
备份保存在 `/home/baoadmin/agentloop-mr/backups/runtime-control-*`。
