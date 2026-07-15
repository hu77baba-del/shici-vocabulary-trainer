import { PaddleOCR } from "@paddleocr/paddleocr-js";

let enginePromise = null;

export function initialize() {
  if (!enginePromise) {
    enginePromise = PaddleOCR.create({
      textDetectionModelName: "PP-OCRv5_mobile_det",
      textDetectionModelAsset: { url: "/vendor/paddleocr/models/PP-OCRv5_mobile_det_onnx_infer.tar" },
      textRecognitionModelName: "PP-OCRv5_mobile_rec",
      textRecognitionModelAsset: { url: "/vendor/paddleocr/models/PP-OCRv5_mobile_rec_onnx_infer.tar" },
      worker: {
        enabled: true,
        createWorker: () => new Worker("/vendor/paddleocr/runtime/ocr-worker.js", { type: "module" })
      },
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: 8,
      ortOptions: {
        backend: "wasm",
        wasmPaths: "/vendor/paddleocr/wasm/",
        numThreads: 2,
        simd: true
      }
    }).catch(error => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

export async function recognize(image) {
  const engine = await initialize();
  const [result] = await engine.predict(image, {
    textDetLimitSideLen: 1280,
    textDetLimitType: "max",
    textDetMaxSideLimit: 2400,
    textDetBoxThresh: 0.5,
    textRecScoreThresh: 0.1
  });
  return result;
}

globalThis.PaddleOCRRuntime = { initialize, recognize };
