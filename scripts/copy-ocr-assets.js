"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sdkDist = path.join(root, "node_modules", "@paddleocr", "paddleocr-js", "dist");
const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");
const runtimeDir = path.join(root, "public", "vendor", "paddleocr", "runtime");
const wasmDir = path.join(root, "public", "vendor", "paddleocr", "wasm");
const modelsDir = path.join(root, "public", "vendor", "paddleocr", "models");

fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(wasmDir, { recursive: true });

const worker = fs.readdirSync(path.join(sdkDist, "assets")).find(name => /^worker-entry-.*\.js$/.test(name));
if (!worker) throw new Error("没有找到 PaddleOCR 工作线程文件");
fs.copyFileSync(path.join(sdkDist, "assets", worker), path.join(runtimeDir, "ocr-worker.js"));

for (const name of fs.readdirSync(ortDist).filter(name => /^ort-wasm.*\.(?:mjs|wasm)$/.test(name))) {
  fs.copyFileSync(path.join(ortDist, name), path.join(wasmDir, name));
}

for (const name of ["PP-OCRv5_mobile_det_onnx_infer.tar", "PP-OCRv5_mobile_rec_onnx_infer.tar"]) {
  if (!fs.existsSync(path.join(modelsDir, name))) throw new Error(`缺少本地 OCR 模型：${name}`);
}

console.log("PaddleOCR 工作线程、WASM 与本地模型已就绪");
