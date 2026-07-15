(function initOcrParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OcrParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createOcrParser() {
  "use strict";

  const HEADER_TEXTS = ["序号", "英文", "词组", "音标", "词性", "中文释义", "词组板块", "单词板块", "粗体词"];
  const PART_OF_SPEECH = /^(?:n|v|adj|adv|prep|pron|conj|num|art|interj|aux|modal)(?:\s+v)?\.?$/i;

  function normalizeText(value) {
    return String(value || "").replace(/[\u00a0\u3000]/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeEnglishText(value) {
    return normalizeText(value).replace(/^[*＊﹡✱✲✳]\s*/, "");
  }

  function countMatches(text, pattern) {
    return (text.match(pattern) || []).length;
  }

  function isEnglishPhrase(line) {
    const text = normalizeEnglishText(line.text);
    const lowerCount = countMatches(text, /[a-z]/g);
    if (Number(line.score) < 0.8 || lowerCount < 2) return false;
    if (PART_OF_SPEECH.test(text)) return false;
    if (!/^[A-Za-z][A-Za-z\s.'’,-]*[A-Za-z.]$/.test(text)) return false;
    return lowerCount / Math.max(1, text.replace(/\s/g, "").length) >= 0.45;
  }

  function isChineseMeaning(line) {
    const text = normalizeText(line.text);
    if (Number(line.score) < 0.85 || countMatches(text, /[\u3400-\u9fff]/g) < 1) return false;
    return !HEADER_TEXTS.some(header => text === header || text.includes(header));
  }

  function rotatePoint(point, rotation, width, height) {
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (rotation === 90) return [height - y, x];
    if (rotation === 180) return [width - x, height - y];
    if (rotation === 270) return [y, width - x];
    return [x, y];
  }

  function transformLine(line, rotation, image) {
    const poly = (line.poly || []).map(point => rotatePoint(point, rotation, image.width, image.height));
    if (!poly.length) return null;
    const xs = poly.map(point => point[0]);
    const ys = poly.map(point => point[1]);
    const x0 = Math.min(...xs); const x1 = Math.max(...xs);
    const y0 = Math.min(...ys); const y1 = Math.max(...ys);
    return {
      text: normalizeText(line.text), score: Number(line.score) || 0, poly,
      x: (x0 + x1) / 2, y: (y0 + y1) / 2,
      width: x1 - x0, height: y1 - y0
    };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function pairMonotonic(english, chinese, maxRowDistance) {
    const en = [...english].sort((a, b) => a.y - b.y);
    const zh = [...chinese].sort((a, b) => a.y - b.y);
    const table = Array.from({ length: en.length + 1 }, () => Array(zh.length + 1));
    table[0][0] = { count: 0, cost: 0, pairs: [] };
    const choose = (current, candidate) => {
      if (!candidate) return current;
      if (!current || candidate.count > current.count || (candidate.count === current.count && candidate.cost < current.cost)) return candidate;
      return current;
    };
    for (let i = 0; i <= en.length; i += 1) {
      for (let j = 0; j <= zh.length; j += 1) {
        const state = table[i][j];
        if (!state) continue;
        if (i < en.length) table[i + 1][j] = choose(table[i + 1][j], state);
        if (j < zh.length) table[i][j + 1] = choose(table[i][j + 1], state);
        if (i < en.length && j < zh.length) {
          const distance = Math.abs(en[i].y - zh[j].y);
          if (zh[j].x > en[i].x && distance <= maxRowDistance) {
            table[i + 1][j + 1] = choose(table[i + 1][j + 1], {
              count: state.count + 1,
              cost: state.cost + distance,
              pairs: [...state.pairs, { en: en[i], zh: zh[j], distance }]
            });
          }
        }
      }
    }
    return table[en.length][zh.length]?.pairs || [];
  }

  function clusterByX(lines, tolerance) {
    const clusters = [];
    [...lines].sort((a, b) => a.x - b.x).forEach(line => {
      let nearest = null;
      let nearestDistance = Infinity;
      clusters.forEach(cluster => {
        const distance = Math.abs(line.x - cluster.x);
        if (distance <= tolerance && distance < nearestDistance) {
          nearest = cluster;
          nearestDistance = distance;
        }
      });
      if (!nearest) {
        clusters.push({ x: line.x, lines: [line] });
        return;
      }
      nearest.lines.push(line);
      nearest.x = median(nearest.lines.map(item => item.x));
    });
    return clusters;
  }

  function compareQuality(left, right) {
    const fields = [
      ["matchedCount", 1],
      ["missingCount", -1],
      ["unmatchedChineseCount", -1],
      ["checkCount", -1],
      ["pairRate", 1],
      ["avgConfidence", 1]
    ];
    for (const [field, direction] of fields) {
      const delta = ((left?.quality?.[field] || 0) - (right?.quality?.[field] || 0)) * direction;
      if (delta !== 0) return delta;
    }
    return (left?.score || -Infinity) - (right?.score || -Infinity);
  }

  function matchOrientation(rawItems, image, rotation) {
    const lines = rawItems.map(item => transformLine(item, rotation, image)).filter(Boolean);
    const english = lines.filter(isEnglishPhrase);
    const chinese = lines.filter(isChineseMeaning);
    if (!english.length || !chinese.length) {
      return {
        rotation, candidates: [], score: -Infinity, pairRate: 0, matchedCount: 0,
        quality: { matchedCount: 0, missingCount: 0, checkCount: 0, unmatchedEnglishCount: english.length, unmatchedChineseCount: chinese.length, pairRate: 0, avgConfidence: 0 }
      };
    }

    const medianHeight = median([...english, ...chinese].map(line => line.height).filter(value => value > 0));
    const maxRowDistance = Math.max(30, medianHeight * 1.8);
    const columnTolerance = Math.max(60, medianHeight * 2);
    const englishColumns = clusterByX(english, columnTolerance);
    const chineseColumns = clusterByX(chinese, columnTolerance);
    let bestColumns = null;

    englishColumns.forEach(enColumn => {
      chineseColumns.forEach(zhColumn => {
        if (zhColumn.x <= enColumn.x) return;
        const pairs = pairMonotonic(enColumn.lines, zhColumn.lines, maxRowDistance);
        if (!pairs.length) return;
        const englishY = enColumn.lines.map(line => line.y);
        const minTableY = Math.min(...englishY) - maxRowDistance;
        const maxTableY = Math.max(...englishY) + maxRowDistance;
        const tableChinese = zhColumn.lines.filter(line => line.y >= minTableY && line.y <= maxTableY);
        const avgConfidence = pairs.reduce((sum, pair) => sum + Math.min(pair.en.score, pair.zh.score), 0) / pairs.length;
        const avgDistance = pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length;
        const pairRate = pairs.length / Math.max(1, enColumn.lines.length, tableChinese.length);
        const columnScore = pairs.length * 120 + pairRate * 40 + avgConfidence * 20 - avgDistance;
        if (!bestColumns || columnScore > bestColumns.score) {
          bestColumns = { english: enColumn.lines, chinese: tableChinese, pairs, pairRate, avgConfidence, avgDistance, score: columnScore };
        }
      });
    });

    if (!bestColumns) {
      return {
        rotation, candidates: [], score: -Infinity, pairRate: 0, matchedCount: 0,
        quality: { matchedCount: 0, missingCount: 0, checkCount: 0, unmatchedEnglishCount: english.length, unmatchedChineseCount: chinese.length, pairRate: 0, avgConfidence: 0 }
      };
    }

    const { pairs, pairRate, avgConfidence } = bestColumns;

    const pairY = pairs.map(pair => pair.en.y);
    const minY = pairY.length ? Math.min(...pairY) - maxRowDistance : -Infinity;
    const maxY = pairY.length ? Math.max(...pairY) + maxRowDistance : Infinity;
    const unmatched = bestColumns.english.filter(en => !pairs.some(pair => pair.en === en)
      && en.score >= 0.92 && en.y >= minY && en.y <= maxY);
    const unmatchedChinese = bestColumns.chinese.filter(zh => !pairs.some(pair => pair.zh === zh));

    const candidates = [
      ...pairs.map(pair => ({
        spelling: normalizeEnglishText(pair.en.text),
        meaning: pair.zh.text.replace(/[·•]+$/, ""),
        confidence: Math.min(pair.en.score, pair.zh.score),
        warning: Math.min(pair.en.score, pair.zh.score) >= 0.92 ? "clear" : "check",
        y: pair.en.y
      })),
      ...unmatched.map(en => ({ spelling: normalizeEnglishText(en.text), meaning: "", confidence: en.score, warning: "missing", y: en.y }))
    ].sort((a, b) => a.y - b.y);

    const quality = {
      matchedCount: pairs.length,
      missingCount: unmatched.length,
      checkCount: candidates.filter(candidate => candidate.warning === "check").length,
      unmatchedEnglishCount: bestColumns.english.length - pairs.length,
      unmatchedChineseCount: unmatchedChinese.length,
      pairRate,
      avgConfidence
    };

    return { rotation, candidates, score: bestColumns.score, pairRate, matchedCount: pairs.length, quality };
  }

  function parse(items, image, sourceImageIndex = 0) {
    const safeImage = { width: Number(image?.width) || 1, height: Number(image?.height) || 1 };
    const attempts = [0, 90, 180, 270].map(rotation => matchOrientation(items || [], safeImage, rotation));
    const best = attempts.sort((a, b) => compareQuality(b, a))[0];
    const candidates = best.candidates.map(candidate => ({
      spelling: candidate.spelling,
      meaning: candidate.meaning,
      confidence: candidate.confidence,
      warning: candidate.warning,
      sourceImageIndex
    }));
    return {
      candidates,
      rotation: best.rotation,
      pairRate: best.pairRate,
      matchedCount: best.matchedCount || 0,
      quality: best.quality,
      needsRetry: (best.matchedCount || 0) < 2 || best.pairRate < 0.7
    };
  }

  return { parse, normalizeText, normalizeEnglishText, isEnglishPhrase, isChineseMeaning, compareQuality };
});
