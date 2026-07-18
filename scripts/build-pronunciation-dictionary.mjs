import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dictionary } from "cmu-pronouncing-dictionary";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "resources", "pronunciation");
const packageDir = path.join(root, "node_modules", "cmu-pronouncing-dictionary");

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "cmudict.json"), `${JSON.stringify(dictionary)}\n`, "utf8");
fs.copyFileSync(path.join(packageDir, "license"), path.join(outputDir, "LICENSE.cmu-pronouncing-dictionary.txt"));

console.log(`已生成离线发音词典：${Object.keys(dictionary).length} 条`);
