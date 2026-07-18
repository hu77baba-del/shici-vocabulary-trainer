# 发音词典来源

- 打包输入：`cmu-pronouncing-dictionary@3.0.0`
- npm 页面：https://www.npmjs.com/package/cmu-pronouncing-dictionary
- CMU 官方资源入口：https://www.cs.cmu.edu/afs/cs.cmu.edu/project/fgdata/ftp/
- CMUdict 上游仓库：https://github.com/cmusphinx/cmudict
- 生成命令：`npm run build:pronunciation`
- 当前生成条目：`135155`

`LICENSE.CMUdict.txt` 保留 CMUdict 上游许可证；`LICENSE.cmu-pronouncing-dictionary.txt` 保留 npm 包本身的 ISC 许可证。普通运行只读取同目录的 `cmudict.json`，不访问网络，也不依赖 `node_modules`。
