#!/bin/zsh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装 Node.js 22 或更高版本，然后重新双击本文件。"
  echo "安装地址：https://nodejs.org/"
  read "?按回车键关闭窗口……"
  exit 1
fi

node server.js --open
echo "学习工具已停止。"
read "?按回车键关闭窗口……"
