# Docker 服务器部署

本项目的源代码在 dapan-cloud-nextjs 分支。Next.js 生产构建由 Linux 构建机完成，并作为 GitHub Release 附件发布；服务器只下载生产包、构建轻量运行镜像，不安装 Node/pnpm，也不编译应用。正式地址为 https://dp.192163.xyz，容器只监听服务器本机 127.0.0.1:3000。

## 首次部署

在 Debian 12 服务器上确认 Docker Engine、Docker Compose、Git 和 curl 已安装，然后执行：

~~~sh
mkdir -p /opt/dapan-cloud
git clone --depth 1 --branch dapan-cloud-nextjs \
  https://github.com/ofoz/dapan-yuntu-clone.git \
  /opt/dapan-cloud/repository
cd /opt/dapan-cloud/repository
bash scripts/deploy-from-github-release.sh
~~~

脚本会从公开 GitHub Release 下载固定版本的 Docker 生产包与 SHA256 文件，核验完整性，再构建镜像并启动服务。默认行情配置为腾讯优先、东方财富备用，缓存 15 秒。应用启动后检查：

~~~sh
curl -fsS http://127.0.0.1:3000/api/heatmap/status
cd /opt/dapan-cloud && docker compose ps
~~~

## 配置 1Panel 与 HTTPS

在 1Panel → 网站 → 创建网站 → 反向代理 中设置：

- 域名：dp.192163.xyz
- 代理地址：http://127.0.0.1:3000
- 申请并绑定 Let's Encrypt 证书
- 开启 HTTP 自动跳转 HTTPS
- 关闭 proxy_buffering 与 proxy_cache，读取超时设为 90 秒以支持行情流

证书申请和自动续期需要域名继续解析到服务器，并保留公网 80 端口。

## 日常管理

~~~sh
cd /opt/dapan-cloud
docker compose ps
docker compose logs --tail=100 dapan-cloud
docker compose restart dapan-cloud
~~~

更新时先发布新的 GitHub Release，再把 scripts/deploy-from-github-release.sh 中的版本号更新为新 Release，提交并从服务器拉取脚本后重新执行。旧镜像与版本目录会保留，便于回滚。
