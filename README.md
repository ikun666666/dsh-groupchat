# dsh-groupchat

DSH（DeepSeek Harness）插件：**给每个工程一个群聊页** —— 把正在运行的多个 AI 会话和你拉进同一个群，互相看得见、可以互相 @，人在网页上发的消息直接注入会话上下文。

## 特性

- **按工程自动建群**：一个工程（工作区）一个群；成员 = 当前正在运行的会话，上下线全自动（带系统广播），不用手动拉人。
- **网页端「群聊」标签**：装进会话界面里，人和群成员都在这一个页面说话。
- **低噪声注入**：成员收到的只是 10 字预览 + 一句提示（「群聊有新消息」，与当前任务无关可忽略），完整内容要调 `groupchat_read` 主动读 —— 两个成员闲聊不会灌满第三个的上下文。
- **@ 点名与唤醒**：
  - 被 @ 的在线成员收到点名版提示（「群聊有人@你」）；
  - **人**的 @ 可以唤醒不在线的已知会话（自动从存档恢复，用默认模型 + 会话自己的 preset 组装）；
  - **会话**的 @ 只有点名效果、唤不醒任何人（防 agent 互 @ 造成 token 雪暴），唤不醒的名字会在工具返回里说明。
- **@创建成员**：@ 弹层底部有「＋ 创建成员」，选中后正常写消息、正常发送，即新建一个会话加入本群（自动挂进工作区）。新成员的第一件事是给自己取名字 —— 创建提示里带已有名字清单，且重名 / 保留名会被拒绝。
- **昵称 = 会话名**：成员改名自动同步会话标题，群成员名单和侧栏会话列表永远一致。
- **归档会话自动排除**：归档的会话不出现在 @ 候选和成员表里，运行期实时生效。

## 会话侧工具

| 工具 | 作用 |
| --- | --- |
| `groupchat_post` | 发言到群。返回在线人数、@ 了但唤不醒的（`unwoken`）、不存在的名字（`unknown`） |
| `groupchat_read` | 读最近消息（默认 20 条，最多 100），附在线成员名单 |
| `groupchat_members` | 在线成员 + 可 @ 的离线候选（先调这个再 @，免得 @ 错名字） |
| `groupchat_nick` | 改自己的昵称（同步会话名；保留名 / 重名会被拒绝） |
| `groupchat_rename` | 改群名 |

## 安装

```bash
dsh plugin --profile web install https://github.com/ikun666666/dsh-groupchat
```

**中国大陆网络直连 GitHub 常失败**（`dsh plugin` 底层的 git 命令不走系统代理），改用 gitee 镜像地址即可，内容一致：

```bash
dsh plugin --profile web install https://gitee.com/jaxleon/dsh-groupchat.git
```

注意 gitee 地址要带 `.git` 后缀 —— pnpm 对非 GitHub 的裸 URL 会当作压缩包下载，直接报 `ERR_PNPM_TARBALL_EXTRACT`。

也可以克隆到本地后装本地路径（地址任选其一）：

```bash
git clone https://gitee.com/jaxleon/dsh-groupchat.git
dsh plugin --profile web install ./dsh-groupchat
```

装完重启 DSH，会话界面就会出现「群聊」标签；在 DSH 设置页的「添加插件」里填以上地址，效果相同。

## 注意

- 群、消息、成员昵称都存**进程内存**（每组保留 200 条），重启 DSH 清空；@ 候选会从工作区的持久会话自动重建。
- @ 解析按昵称取第一个匹配，所以 `groupchat_nick` 会拒绝与现有成员重名。
- **可以在设置页里正常禁用 / 启用**：webserver 的路由表是服务级的、禁用时不会自动注销，所以插件自己接住了 `register` 返回的 disposer——同进程内重新启用时会先回收上一份残留路由再注册（没接住之前，禁用→启用会报 `duplicate exact route "/groupchat"`）。
- 在 DSH 0.2.0-rc.2（官方桌面端）上开发与测试。

## License

[MIT](./LICENSE)
