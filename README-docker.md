# 背书吧 · Docker 部署

## 快速开始

```bash
docker compose up -d --build
```

然后访问 <http://localhost:3000>。

## 数据持久化

- SQLite 数据库位于容器内 `/app/data/beishuba.db`（通过 `DATABASE_URL=file:/app/data/beishuba.db` 配置）。
- `docker-compose.yml` 将宿主机 `./data` 目录挂载到 `/app/data`，**所有用户数据（背书卡、账号、设置等）都在这个卷里**。
- 升级镜像只需 `git pull && docker compose up -d --build`，数据不会丢失；备份时直接拷贝 `./data` 目录即可。

## 镜像构建

- GitHub Actions（`.github/workflows/docker.yml`）会在推送 `v*` 标签（如 `v1.0.0`）时自动构建并推送镜像到 GHCR：`ghcr.io/cshdotcom/beishuba`。
- 标签推送生成 `vX.Y.Z` 版本标签；从默认分支手动触发（workflow_dispatch）时会额外打上 `latest`。
- 本地手动构建：`docker build -t beishuba .`

## 首次初始化

- 应用为**单账号**模式：首次访问时页面会引导注册唯一的管理员账号，之后仅可登录使用。
- 容器以非 root 用户（`node`）运行，`/app/data` 为可写卷，满足 SQLite 的读写需求。
