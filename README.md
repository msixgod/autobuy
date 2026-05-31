# AutoBuy Desktop

这个项目当前的主交付物是一个跨平台桌面 App，用来完成微信挂号页面的会话采集、号源监听和自动锁号。

## 主要能力

- 内置 HTTPS 代理，抓取 `wis2.trasen.womei.org/api/*`
- 自动提取 `token / orgCode / 医生 / 就诊人 / 就诊卡`
- 监听目标医生、日期、上午下午和具体时间
- 命中后直接调用下单接口锁号
- 返回支付链接，用户自己完成支付

## 项目结构

- `src/main/*`
  桌面端主进程、代理、解密、下单逻辑
- `src/renderer/*`
  桌面端界面
- `trasen_api_scraper.py`
  直连接口抓取验证脚本
- `trasen_bot.py`
  Python 监听和下单脚本
- `trasen_capture_decode.py`
  抓包数据解密和汇总脚本
- `trasen-assist.user.js`
  页内辅助面板

## 桌面端运行

```powershell
npm install
npm start
```

## Windows 打包

```powershell
npm run build:win
```

## macOS 打包

```powershell
npm run build:mac
```

说明：

- Windows 版已经完成本地打包验证
- macOS 版需要在 Mac 上执行正式打包

## 本地密钥配置

出于安全原因，仓库里不再包含真实的 Trasen 密钥常量。

桌面端和解密脚本会从环境变量读取下面 3 个值：

- `TRASEN_APP_ID`
- `TRASEN_APP_SECRET`
- `TRASEN_AES_KEY`

示例文件见：

- [.env.example](C:/Users/M/Desktop/autobuy/.env.example)

你可以在本机自行创建 `.env` 或直接设置系统环境变量。

Python 示例配置里也已经改成占位符：

- [trasen_config.example.json](C:/Users/M/Desktop/autobuy/trasen_config.example.json)
- [trasen_bot_config.example.json](C:/Users/M/Desktop/autobuy/trasen_bot_config.example.json)

## 首次使用

最终用户说明见：

- [APP_QUICKSTART_CN.md](C:/Users/M/Desktop/autobuy/APP_QUICKSTART_CN.md)

## 已忽略的本地文件

下面这些不会进入 Git：

- `.env`
- `node_modules/`
- `dist/`
- `trasen_config.json`
- `trasen_bot_config.json`
- `trasen_output.json`
- `trasen_capture*.json*`
- 日志文件
