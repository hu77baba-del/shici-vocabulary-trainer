(function initOcrParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OcrParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createOcrParser() {
  "use strict";

  const HEADER_TEXTS = ["序号", "单词", "英文", "词组", "音标", "词性", "中文释义", "词组板块", "单词板块", "粗体词"];
  const ROW_HEADER_TEXTS = new Set(["序号", "单词", "英文", "词组", "音标", "词性", "中文释义"]);
  const PART_OF_SPEECH = /^(?:n|v|adj|adv|prep|pron|conj|num|art|interj|aux|modal)(?:\s+v)?\.?$/i;

  function normalizeText(value) {
    return String(value || "").replace(/[\u00a0\u3000]/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeEnglishText(value) {
    return normalizeText(value).replace(/^[*＊﹡✱✲✳]\s*/, "").replace(/\s*\/\s*/g, "/");
  }

  function normalizeChineseMeaningText(value) {
    return normalizeText(value).replace(/^(?:中文释义|中文意思|释义)\s*[:：]?\s*/, "");
  }

  function countMatches(text, pattern) {
    return (text.match(pattern) || []).length;
  }

  function isEnglishPhrase(line) {
    const text = normalizeEnglishText(line.text);
    const lowerCount = countMatches(text, /[a-z]/g);
    if (Number(line.score) < 0.8 || lowerCount < 2) return false;
    if (PART_OF_SPEECH.test(text)) return false;
    if (!/^[A-Za-z][A-Za-z\s.'’,\/-]*[A-Za-z.]$/.test(text)) return false;
    if (/(?:^|[^A-Za-z])\/|\/(?:[^A-Za-z]|$)/.test(text)) return false;
    return lowerCount / Math.max(1, text.replace(/\s/g, "").length) >= 0.45;
  }

  function isChineseMeaning(line) {
    const text = normalizeChineseMeaningText(line.text);
    const chineseCount = countMatches(text, /[\u3400-\u9fff]/g);
    const latinCount = countMatches(text, /[A-Za-z]/g);
    if (Number(line.score) < 0.85 || chineseCount < 1) return false;
    if (latinCount > Math.max(6, chineseCount * 1.5)) return false;
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
      left: x0, right: x1, width: x1 - x0, height: y1 - y0
    };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function rowPosition(line) {
    return Number.isFinite(line.rowY) ? line.rowY : line.y;
  }

  function estimateRowSlope(lines, medianHeight) {
    const headers = lines.filter(line => ROW_HEADER_TEXTS.has(normalizeText(line.text)));
    const slopes = [];
    const minimumSpan = Math.max(60, medianHeight * 3);
    for (let i = 0; i < headers.length; i += 1) {
      for (let j = i + 1; j < headers.length; j += 1) {
        const dx = headers[j].x - headers[i].x;
        if (Math.abs(dx) < minimumSpan) continue;
        const slope = (headers[j].y - headers[i].y) / dx;
        if (Number.isFinite(slope) && Math.abs(slope) <= 0.45) slopes.push(slope);
      }
    }
    return slopes.length ? median(slopes) : 0;
  }

  function pairMonotonic(english, chinese, maxRowDistance) {
    const en = [...english].sort((a, b) => rowPosition(a) - rowPosition(b));
    const zh = [...chinese].sort((a, b) => rowPosition(a) - rowPosition(b));
    const directEn = [...english].sort((a, b) => a.y - b.y);
    const directZh = [...chinese].sort((a, b) => a.y - b.y);
    if (directEn.length >= 3 && directEn.length === directZh.length && directZh.every((line, index) => line.x > directEn[index].x)) {
      const enSpan = directEn[directEn.length - 1].y - directEn[0].y;
      const zhSpan = directZh[directZh.length - 1].y - directZh[0].y;
      if (enSpan > 0 && zhSpan > 0) {
        const shapeDistances = directEn.map((line, index) => Math.abs(
          (line.y - directEn[0].y) / enSpan
          - (directZh[index].y - directZh[0].y) / zhSpan
        ));
        const sortedDistances = [...shapeDistances].sort((a, b) => a - b);
        const highDistance = sortedDistances[Math.floor((sortedDistances.length - 1) * 0.9)];
        if (highDistance <= 0.08) {
          return directEn.map((line, index) => ({
            en: line,
            zh: directZh[index],
            distance: shapeDistances[index] * maxRowDistance
          }));
        }
      }
    }
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
          const distance = Math.abs(rowPosition(en[i]) - rowPosition(zh[j]));
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
    [...lines].sort((a, b) => a.left - b.left).forEach(line => {
      let nearest = null;
      let nearestDistance = Infinity;
      clusters.forEach(cluster => {
        const distance = Math.abs(line.left - cluster.x);
        if (distance <= tolerance && distance < nearestDistance) {
          nearest = cluster;
          nearestDistance = distance;
        }
      });
      if (!nearest) {
        clusters.push({ x: line.left, lines: [line] });
        return;
      }
      nearest.lines.push(line);
      nearest.x = median(nearest.lines.map(item => item.left));
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
        quality: { matchedCount: 0, missingCount: 0, checkCount: 0, unmatchedEnglishCount: english.length, unmatchedChineseCount: chinese.length, pairRate: 0, avgConfidence: 0, rowSlope: 0 }
      };
    }

    const medianHeight = median([...english, ...chinese].map(line => line.height).filter(value => value > 0));
    const rowSlope = estimateRowSlope(lines, medianHeight);
    lines.forEach(line => { line.rowY = line.y - rowSlope * line.x; });
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
        const pairedEnglishY = pairs.map(pair => rowPosition(pair.en));
        const minTableY = Math.min(...pairedEnglishY) - maxRowDistance;
        const maxTableY = Math.max(...pairedEnglishY) + maxRowDistance;
        const tableEnglish = enColumn.lines.filter(line => pairs.some(pair => pair.en === line)
          || (rowPosition(line) >= minTableY && rowPosition(line) <= maxTableY));
        const tableChinese = zhColumn.lines.filter(line => pairs.some(pair => pair.zh === line)
          || (rowPosition(line) >= minTableY && rowPosition(line) <= maxTableY));
        const avgConfidence = pairs.reduce((sum, pair) => sum + Math.min(pair.en.score, pair.zh.score), 0) / pairs.length;
        const avgDistance = pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length;
        const pairRate = pairs.length / Math.max(1, tableEnglish.length, tableChinese.length);
        const columnScore = pairs.length * 120 + pairRate * 40 + avgConfidence * 20 - avgDistance;
        if (!bestColumns || columnScore > bestColumns.score) {
          bestColumns = { english: tableEnglish, chinese: tableChinese, pairs, pairRate, avgConfidence, avgDistance, score: columnScore };
        }
      });
    });

    if (!bestColumns) {
      return {
        rotation, candidates: [], score: -Infinity, pairRate: 0, matchedCount: 0,
        quality: { matchedCount: 0, missingCount: 0, checkCount: 0, unmatchedEnglishCount: english.length, unmatchedChineseCount: chinese.length, pairRate: 0, avgConfidence: 0, rowSlope }
      };
    }

    const { pairs, pairRate, avgConfidence } = bestColumns;

    const pairY = pairs.map(pair => rowPosition(pair.en));
    const minY = pairY.length ? Math.min(...pairY) - maxRowDistance : -Infinity;
    const maxY = pairY.length ? Math.max(...pairY) + maxRowDistance : Infinity;
    const unmatched = bestColumns.english.filter(en => !pairs.some(pair => pair.en === en)
      && en.score >= 0.92 && rowPosition(en) >= minY && rowPosition(en) <= maxY);
    const unmatchedChinese = bestColumns.chinese.filter(zh => !pairs.some(pair => pair.zh === zh));

    const candidates = [
      ...pairs.map(pair => ({
        spelling: normalizeEnglishText(pair.en.text),
        meaning: normalizeChineseMeaningText(pair.zh.text).replace(/[·•]+$/, ""),
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
      avgConfidence,
      rowSlope
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
    const matchedCount = best.matchedCount || 0;
    const needsRetry = matchedCount === 0;
    const needsReview = matchedCount > 0 && (best.pairRate < 0.7 || best.quality.missingCount > 0 || best.quality.checkCount > 0);
    return {
      candidates,
      rotation: best.rotation,
      pairRate: best.pairRate,
      matchedCount,
      quality: best.quality,
      needsRetry,
      needsReview
    };
  }

  return { parse, normalizeText, normalizeEnglishText, normalizeChineseMeaningText, isEnglishPhrase, isChineseMeaning, compareQuality };
});
