const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, HeadingLevel, PageBreak,
  ShadingType, TableLayoutType, VerticalAlign, convertInchesToTwip,
  PageOrientation
} = require("docx");

// Load data - filter by date range and exclude unknown persons (0h records)
// Usage: node gen_month_docx.js <start_YYYY-MM-DD> <end_YYYY-MM-DD> [input.json]
// Example: node gen_month_docx.js 2026-07-20 2026-08-21 combined_data.json
const args = process.argv.slice(2);
const rangeStart = args[0] || "2026-07-01";
const rangeEnd = args[1] || "2026-07-31";
const inputFile = args[2] || "c:\\Users\\HONOR\\.trae-cn\\work\\6a5dc6c8f3dd409051bb8edc\\combined_data.json";
const [startYr, startMo, startDy] = rangeStart.split("-").map(Number);
const [endYr, endMo, endDy] = rangeEnd.split("-").map(Number);

const rawData = JSON.parse(fs.readFileSync(inputFile, "utf-8"));

// Warn about unmapped persons before filtering
const unknownPersons = rawData.filter(r => r.person.startsWith("未知") && r.total_hrs > 0);
if (unknownPersons.length > 0) {
  console.warn("\n============================================================");
  console.warn("WARNING: Found unmapped persons in data! These records will be EXCLUDED:");
  const personDates = {};
  for (const r of unknownPersons) {
    const key = r.person;
    if (!personDates[key]) personDates[key] = [];
    personDates[key].push(r.date);
  }
  for (const [person, dates] of Object.entries(personDates)) {
    console.warn(`  ${person}: ${dates.join(", ")} (${dates.length} records)`);
  }
  console.warn("Update USER_MAP in extract script and re-extract data to include them!");
  console.warn("============================================================\n");
}

const data = rawData.filter(r => {
  if (r.person.startsWith("未知") || r.total_hrs <= 0) return false;
  const afterStart = (r.yr > startYr) || (r.yr === startYr && r.mo > startMo) || (r.yr === startYr && r.mo === startMo && r.dy >= startDy);
  const beforeEnd = (r.yr < endYr) || (r.yr === endYr && r.mo < endMo) || (r.yr === endYr && r.mo === endMo && r.dy <= endDy);
  return afterStart && beforeEnd;
});

// ============ Statistics ============
const projHours = {};
const projPeople = {};
const personHours = {};
const personProjects = {};
const personDays = {};
const personProjHours = {}; // person -> project -> hours

for (const r of data) {
  // Person totals
  personHours[r.person] = (personHours[r.person] || 0) + r.total_hrs;
  personDays[r.person] = personDays[r.person] || new Set();
  personDays[r.person].add(`${r.yr}/${r.mo}/${r.dy}`);
  personProjects[r.person] = personProjects[r.person] || new Set();
  personProjHours[r.person] = personProjHours[r.person] || {};

  for (const p of r.projects) {
    // Project totals
    projHours[p.project] = (projHours[p.project] || 0) + p.hours;
    projPeople[p.project] = projPeople[p.project] || new Set();
    projPeople[p.project].add(r.person);

    // Person-project
    personProjects[r.person].add(p.project);
    personProjHours[r.person][p.project] = (personProjHours[r.person][p.project] || 0) + p.hours;
  }
}

const totalHours = Object.values(personHours).reduce((a, b) => a + b, 0);
const totalRecords = data.length;
const uniqueDays = new Set(data.map(r => `${r.yr}/${r.mo}/${r.dy}`)).size;
const projectCount = Object.keys(projHours).length;
const personCount = Object.keys(personHours).length;
const personDaysTotal = Object.values(personDays).reduce((a, s) => a + s.size, 0);

// Calculate date range (actual data coverage within the target month)
const dateStrings = data.map(r => r.date_raw.split("T")[0].replace(/\//g, "-")).sort();
const startDateStr = dateStrings[0];
const endDateStr = dateStrings[dateStrings.length - 1];
const formatDate = (s) => {
  const [y, m, d] = s.split("-");
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
};
// Month label for cover title
const monthLabel = `${startMo}月${startDy}日-${endMo}月${endDy}日`;

// Clean project name (remove 〓)
const cleanName = n => n.replace(/〓/g, "").replace(/〓/g, "");

// Extract person name from "岗位 姓名" format (e.g. "后端 马少平" -> "马少平")
const cleanPerson = p => p.includes(" ") ? p.split(" ").slice(1).join(" ") : p;

const sortedProjects = Object.keys(projHours).sort();
const sortedPersons = Object.keys(personHours).sort();

// ============ Helper Functions ============
const FONT = "Microsoft YaHei";
const FONT_SONG = "SimSun";

function p(text, opts = {}) {
  return new Paragraph({
    alignment: opts.alignment || AlignmentType.LEFT,
    spacing: opts.spacing || { before: 60, after: 60 },
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [
      new TextRun({
        text: text,
        font: opts.font || FONT,
        size: opts.size || 21, // 10.5pt
        bold: opts.bold || false,
        color: opts.color || "333333",
      }),
    ],
    ...(opts.heading ? { heading: opts.heading } : {}),
  });
}

function pdStr(hours) {
  const pd = Math.round(hours / 8 * 10) / 10;
  return Number.isInteger(pd) ? String(pd) : pd.toFixed(1);
}

function heading(text, level = HeadingLevel.HEADING_2) {
  return new Paragraph({
    heading: level,
    alignment: AlignmentType.LEFT,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text: text,
        font: FONT,
        size: level === HeadingLevel.HEADING_1 ? 32 : 28,
        bold: true,
        color: "1a1a1a",
      }),
    ],
  });
}

function cell(text, opts = {}) {
  // Use PERCENTAGE width to ensure table fills page regardless of orientation
  const widthSpec = opts.widthPct
    ? { size: opts.widthPct, type: WidthType.PERCENTAGE }
    : opts.width ? { size: opts.width, type: WidthType.DXA } : undefined;
  return new TableCell({
    width: widthSpec,
    shading: opts.shading ? { type: ShadingType.SOLID, color: opts.shading } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: opts.alignment || AlignmentType.CENTER,
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({
            text: String(text),
            font: opts.font || FONT,
            size: opts.size || 20,
            bold: opts.bold || false,
            color: opts.color || "333333",
          }),
        ],
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
    },
  });
}

function headerCell(text, opts = {}) {
  return cell(text, { bold: true, shading: "E8F0FE", ...opts });
}

function makeRow(cells) {
  return new TableRow({ children: cells });
}

// ============ Build Work Summary ============
// Key: progress-N maps to projects[N-1], NOT to all projects of the day

// Check if progress text contains meaningful work description
// Returns false for pure status like "100%", "100%（未联调）", "（未开发）"
function isProgressMeaningful(text) {
  if (!text || !text.trim()) return false;
  const cleaned = text.trim();
  if (/^\d+%/.test(cleaned)) return false;
  if (/^[（(].*[)）]$/.test(cleaned)) return false;
  if (cleaned.length < 4) return false;
  return true;
}

// Character-level Jaccard similarity for detecting reordered items
function charJaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const c of setA) if (setB.has(c)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

// Merge similar items: prefix match >=5, inclusion, or char similarity >=0.7
// Skip items that are already thematic groups (相关工作/相关问题处理) to avoid false merges
function mergeSimilarItems(items) {
  const unique = [...new Set(items)].filter(t => t && t.trim());
  const sorted = unique.sort((a, b) => a.length - b.length);
  const merged = [];
  for (const item of sorted) {
    const label = getItemLabel(item);
    const isGroup = label.includes("相关工作") || label.includes("相关问题处理") || label === "运维及其他工作";
    const isSimilar = merged.some(m => {
      const mLabel = getItemLabel(m);
      if (mLabel.includes(label) || label.includes(mLabel)) return true;
      let commonLen = 0;
      for (let i = 0; i < Math.min(item.length, m.length); i++) {
        if (item[i] === m[i]) commonLen++;
        else break;
      }
      if (commonLen >= 5) return true;
      if (isGroup || mLabel.includes("相关工作") || mLabel.includes("相关问题处理") || mLabel === "运维及其他工作") return false;
      if (item.length >= 4 && m.length >= 4 && charJaccard(item, m) >= 0.7) return true;
      return false;
    });
    if (!isSimilar) merged.push(item);
  }
  return merged;
}

// Find common prefix of two strings
function commonPrefix(a, b) {
  let len = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) len++;
    else break;
  }
  return a.substring(0, len);
}

// Find common suffix of two strings
function commonSuffix(a, b) {
  let len = 0;
  const maxLen = Math.min(a.length, b.length);
  for (let i = 1; i <= maxLen; i++) {
    if (a[a.length - i] === b[b.length - i]) len++;
    else break;
  }
  return a.substring(a.length - len);
}

// Trim trailing structural words from a string
function trimTrailingCommon(s) {
  return s.replace(/(信息发布|发布功能|模块|功能|发布|信息)+$/, '');
}

// Remove colons: short prefix (<=4 chars) just drop colon, longer prefix replace with comma
function removeColons(text) {
  return text.replace(/(.{1,4})：/g, "$1").replace(/：/g, "，");
}

// Group thematically related items: when 3+ items share a common prefix (>=2 chars),
// merge ALL into one summary. If more than 5 items, list the 5 shortest.
function groupThemes(items) {
  if (items.length < 3) return items;

  const used = new Set();
  const result = [];

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const iLabel = getItemLabel(items[i]);
    if (iLabel.includes("相关问题处理") || iLabel === "运维及其他工作") continue;

    const groupIndices = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const jLabel = getItemLabel(items[j]);
      if (jLabel.includes("相关问题处理") || jLabel === "运维及其他工作") continue;
      const prefix = commonPrefix(items[i], items[j]);
      if (prefix.length >= 2) {
        groupIndices.push(j);
      }
    }

    if (groupIndices.length >= 3) {
      let allPrefix = items[groupIndices[0]];
      for (const idx of groupIndices) {
        allPrefix = commonPrefix(allPrefix, items[idx]);
      }

      if (allPrefix.length >= 2) {
        let displayName = allPrefix;
        if (displayName === "生产" || displayName === "生产环境") {
          displayName = "其他运维";
        }
        if (displayName === "处理") {
          displayName = "其他";
        }

        let itemsToList = groupIndices.map(idx => items[idx]);
        if (itemsToList.length > 5) {
          itemsToList = itemsToList.sort((a, b) => a.length - b.length).slice(0, 5);
        }

        result.push(`${displayName}相关工作：包括${itemsToList.join("、")}等`);
        groupIndices.forEach(idx => used.add(idx));
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    if (!used.has(i)) result.push(items[i]);
  }

  return result;
}

// Merge items sharing a 4+ char common prefix into a generalized name
// e.g. "沟通功能开发" + "沟通功能调整" -> "沟通功能优化"
// e.g. "合同查询速度优化" + "合同查询导出" + "合同查询功能" -> "合同查询相关工作"
function mergeByPrefix(items) {
  const used = new Set();
  const result = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const iLabel = getItemLabel(items[i]);
    if (iLabel.includes("相关工作") || iLabel.includes("相关问题处理") || iLabel === "运维及其他工作") { result.push(items[i]); continue; }
    const group = [items[i]];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const jLabel = getItemLabel(items[j]);
      if (jLabel.includes("相关工作") || jLabel.includes("相关问题处理") || jLabel === "运维及其他工作") continue;
      const prefix = commonPrefix(items[i], items[j]);
      if (prefix.length >= 4) { group.push(items[j]); used.add(j); }
    }
    if (group.length >= 2) {
      let prefix = group[0];
      for (const item of group) prefix = commonPrefix(prefix, item);
      if (prefix.length >= 4) {
        const suffixes = group.map(item => item.substring(prefix.length));
        const actionVerbs = /^(开发|调整|改造|优化|修改|完善|测试|验证)$/;
        const allActions = suffixes.every(s => actionVerbs.test(s));
        if (allActions && group.length === 2) {
          result.push(prefix + "优化");
        } else {
          result.push(prefix + "相关工作");
        }
        used.add(i);
        continue;
      }
    }
    result.push(items[i]);
  }
  return result;
}

// Merge items in the same work category (e.g. 3+ document items -> "编写说明文档")
function mergeByCategory(items) {
  const categoryConfig = [
    { pattern: /文档|说明|填写|编写|安扫|报告|纪要/, label: "编写说明文档" },
    { pattern: /问题处理|问题缺陷|报错|bug|修复|丢失|排查|问题$/, label: "问题处理相关工作", exclude: /^处理/ },
    { pattern: /操作指引/, label: "操作指引沟通" },
  ];
  let result = [...items];
  for (const { pattern, label, exclude } of categoryConfig) {
    const matching = result.filter(item => pattern.test(item) && !item.includes("相关工作") && !item.includes("相关问题处理") && !(exclude && exclude.test(item)));
    if (matching.length >= 3) {
      const nonMatching = result.filter(item => !pattern.test(item) || item.includes("相关工作") || item.includes("相关问题处理") || (exclude && exclude.test(item)));
      result = [...nonMatching, label];
    }
  }
  return result;
}

// Classify a work item into a category for sorting
function classifyWork(item) {
  const label = getItemLabel(item);
  // Thematic groups: classify by prefix
  if (label.includes("相关问题处理")) {
    const prefix = label.split("相关问题处理")[0].replace(/及$/, "");
    if (/工作量|评估/.test(prefix)) return "售前";
    if (/问题|处理|排查|报错|失败|驳回/.test(prefix)) return "问题处理";
    if (/运维|生产|环境|部署|发版|巡检/.test(prefix)) return "运维";
    if (/文档|说明/.test(prefix)) return "文档";
    if (/功能|开发/.test(prefix)) return "功能开发";
    if (/需求|熟悉|会议|沟通/.test(prefix)) return "需求沟通";
    if (/售前|投标|演示/.test(prefix)) return "售前";
    return "功能开发";
  }
  if (label.includes("相关工作")) {
    const prefix = label.split("相关工作")[0];
    if (/工作量|评估/.test(prefix)) return "售前";
    if (/问题|处理|排查|报错|失败|驳回/.test(prefix)) return "问题处理";
    if (/运维|生产|环境|部署|发版|巡检/.test(prefix)) return "运维";
    if (/文档|说明/.test(prefix)) return "文档";
    if (/功能|开发/.test(prefix)) return "功能开发";
    if (/需求|熟悉|会议|沟通/.test(prefix)) return "需求沟通";
    if (/售前|投标|演示/.test(prefix)) return "售前";
    return "功能开发";
  }
  if (label === "运维及其他工作") return "运维";
  // Individual items - check in priority order
  if (/工作量|评估/.test(label)) return "售前";
  if (/开发|优化|调整|改造|迁移|搭建|实现|联调|验证|测试|功能/.test(label)) return "功能开发";
  if (/问题|bug|报错|排查|驳回|修复|丢失/i.test(label)) return "问题处理";
  if (/文档|说明|填写|编写|报告|纪要|安扫/.test(label)) return "文档";
  if (/运维|发版|部署|环境|巡检|监控|生产/.test(label)) return "运维";
  if (/需求|熟悉|会议|对接|沟通|梳理/.test(label)) return "需求沟通";
  if (/售前|投标|演示/.test(label)) return "售前";
  return "其他";
}

// Sort items by category order, thematic groups first within each category
function sortByCategory(items) {
  const categoryOrder = ["功能开发", "问题处理", "文档", "运维", "需求沟通", "售前", "其他"];
  return items.sort((a, b) => {
    const aLabel = getItemLabel(a);
    const bLabel = getItemLabel(b);
    if (aLabel === "运维及其他工作") return 1;
    if (bLabel === "运维及其他工作") return -1;
    const ca = classifyWork(a);
    const cb = classifyWork(b);
    const ia = categoryOrder.indexOf(ca);
    const ib = categoryOrder.indexOf(cb);
    if (ia !== ib) return ia - ib;
    const aGroup = (aLabel.includes("相关问题处理") || aLabel.includes("相关工作")) ? 0 : 1;
    const bGroup = (bLabel.includes("相关问题处理") || bLabel.includes("相关工作")) ? 0 : 1;
    return aGroup - bGroup;
  });
}

// Format work items: sort by category then number each item
function formatWorkItems(items) {
  items = sortByCategory(items);
  return items.map((item, i) => `${i + 1}. ${item}`);
}

function buildPersonSummary() {
  const result = [];
  for (const person of sortedPersons) {
    const projects = personProjects[person];
    const projList = sortedProjects.filter(p => projects.has(p));

    const projectData = [];
    for (const proj of projList) {
      const hrs = personProjHours[person][proj];
      const days = new Set();
      const tasks = new Set();
      const progresses = [];
      for (const r of data) {
        if (r.person !== person) continue;
        for (let i = 0; i < r.projects.length; i++) {
          const p = r.projects[i];
          if (p.project === proj) {
            days.add(r.date);
            if (p.task) tasks.add(p.task);
            const progressKey = `progress${i + 1}`;
            const progressText = r[progressKey];
            if (progressText) {
              progresses.push({ text: progressText, date: r.date });
            }
          }
        }
      }

      // Step 1: Extract meaningful work from progress notes (with colon removal and day tracking)
      let mainWork = [];
      const seen = new Set();
      const itemDays = {};
      for (const { text: prog, date } of progresses) {
        const lines = prog.split("\n").filter(l => l.trim());
        for (const line of lines) {
          let cleaned = line.trim().replace(/^\d+[、.．]\s*/, "");
          cleaned = removeColons(cleaned);
          if (isProgressMeaningful(cleaned) && cleaned.length < 50) {
            if (!seen.has(cleaned)) {
              seen.add(cleaned);
              mainWork.push(cleaned);
              itemDays[cleaned] = new Set();
            }
            itemDays[cleaned].add(date);
          }
        }
      }

      // Step 2: If progress notes are too short, combine with task names
      if (mainWork.length > 0 && tasks.size > 0) {
        const taskArr = [...tasks].map(removeColons);
        for (let i = 0; i < mainWork.length; i++) {
          if (mainWork[i].length < 6) {
            mainWork[i] = `${taskArr[0]}${mainWork[i]}`;
          }
        }
      }

      // Step 3: If no progress notes at all, fall back to task names
      if (mainWork.length === 0 && tasks.size > 0) {
        mainWork.push(...[...tasks].map(removeColons));
      }

      // Filter trivial tasks (just submitting scripts/code)
      const filteredWork = filterTrivialTasks(mainWork);
      if (filteredWork.length > 0) mainWork = filteredWork;

      // Smart merge pipeline
      let merged = mergeByPrefix(mainWork);
      merged = mergeByCategory(merged);
      merged = mergeSimilarItems(merged);
      let grouped = groupThemes(merged);
      // Always apply unified simplification (rename, merge, dedup)
      grouped = simplifySummary(grouped, true);
      // If too many, keep only thematic groups and category labels
      if (grouped.length > 15) {
        const important = grouped.filter(item =>
          item.includes("相关问题处理") ||
          getItemLabel(item) === "运维及其他工作" ||
          item.includes("相关工作") ||
          item === "编写说明文档" ||
          item === "操作指引沟通"
        );
        if (important.length >= 3) grouped = important;
      }
      // If still many, drop 1-day non-thematic items (keep series work and multi-day items)
      if (grouped.length > 8) {
        const dayFiltered = grouped.filter(item => {
          if (item.includes("相关问题处理") || getItemLabel(item) === "运维及其他工作") return true;
          if (item.includes("相关工作")) return true;
          if (item === "编写说明文档" || item === "操作指引沟通") return true;
          if (itemDays[item] && itemDays[item].size > 1) return true;
          for (const [orig, days] of Object.entries(itemDays)) {
            if (item === orig || item.includes(orig) || orig.includes(item) || charJaccard(item, orig) >= 0.7) {
              if (days.size > 1) return true;
            }
          }
          return false;
        });
        if (dayFiltered.length >= 3) grouped = dayFiltered;
      }
      // If still many, drop secondary/setup tasks
      if (grouped.length > 8) {
        grouped = dropSecondaryTasks(grouped);
      }
      const items = formatWorkItems(grouped);

      projectData.push({
        name: cleanName(proj),
        hours: hrs,
        days: days.size,
        items: items
      });
    }
    result.push({
      person: person,
      totalHours: personHours[person],
      days: personDays[person].size,
      projects: projectData
    });
  }
  return result;
}

// Helper: extract main label (before "：包括") and details (after "：包括")
function getItemLabel(item) {
  const idx = item.indexOf("：包括");
  return idx >= 0 ? item.substring(0, idx) : item;
}
function getItemDetails(item) {
  const idx = item.indexOf("：包括");
  return idx >= 0 ? item.substring(idx) : "";
}

// Merge related thematic groups (e.g. "合同" + "历史合同" → "合同及历史合同")
// Handles items with details: "XX相关问题处理：包括A、B等" → combine details when merging
function mergeRelatedGroups(items) {
  const suffix = "相关问题处理";
  const groups = items.filter(item => getItemLabel(item).endsWith(suffix));
  const others = items.filter(item => !getItemLabel(item).endsWith(suffix));
  if (groups.length < 2) return items;

  const used = new Set();
  const result = [];
  const relatedPairs = [["发票", "开票"], ["合同", "历史"], ["合同", "合同历史"]];

  for (let i = 0; i < groups.length; i++) {
    if (used.has(i)) continue;
    const label1 = getItemLabel(groups[i]);
    const details1 = getItemDetails(groups[i]);
    const p1 = label1.replace(new RegExp(suffix + "$"), "");
    const mergeList = [{ p: p1, d: details1 }];
    for (let j = i + 1; j < groups.length; j++) {
      if (used.has(j)) continue;
      const label2 = getItemLabel(groups[j]);
      const details2 = getItemDetails(groups[j]);
      const p2 = label2.replace(new RegExp(suffix + "$"), "");
      if (p1.includes(p2) || p2.includes(p1)) { mergeList.push({ p: p2, d: details2 }); used.add(j); continue; }
      for (const [a, b] of relatedPairs) {
        if ((p1.includes(a) && p2.includes(b)) || (p1.includes(b) && p2.includes(a))) {
          mergeList.push({ p: p2, d: details2 }); used.add(j); break;
        }
      }
    }
    if (mergeList.length > 1) {
      mergeList.sort((a, b) => a.p.length - b.p.length);
      const shortest = mergeList[0].p;
      const allContain = mergeList.every(m => m.p === shortest || m.p.includes(shortest));
      let newLabel;
      if (allContain) {
        const longers = mergeList.slice(1).map(m => m.p);
        newLabel = `${shortest}及${longers.join("及")}${suffix}`;
      } else {
        let label = null;
        for (const [a, b] of relatedPairs) {
          if (mergeList.some(m => m.p.includes(a)) && mergeList.some(m => m.p.includes(b))) { label = a; break; }
        }
        newLabel = label ? `${label}${suffix}` : `${mergeList.map(m => m.p).join("及")}${suffix}`;
      }
      // Combine details if present
      const allDetails = mergeList.map(m => m.d).filter(d => d);
      if (allDetails.length > 0) {
        const content = allDetails.map(d => d.replace(/^：包括/, "").replace(/等$/, "")).join("、");
        result.push(`${newLabel}：包括${content}等`);
      } else {
        result.push(newLabel);
      }
    } else {
      result.push(groups[i]);
    }
    used.add(i);
  }
  return [...others, ...result];
}

// Merge sub-categories into broader catch-all categories
// e.g., "运维及其他工作" absorbs "运维相关问题处理" since the former already covers all 运维 work
function mergeSubCategories(items) {
  const broadCategories = [
    { label: "运维及其他工作", category: "运维" },
  ];
  let result = [...items];
  for (const { label: broadLabel, category: broadCat } of broadCategories) {
    if (!result.some(item => getItemLabel(item) === broadLabel)) continue;
    const absorbedDetails = [];
    const filtered = [];
    let broadItem = null;
    for (const item of result) {
      const label = getItemLabel(item);
      if (label === broadLabel) {
        if (!broadItem) {
          broadItem = item;
        } else {
          const d = getItemDetails(item);
          if (d) absorbedDetails.push(d.replace(/^：包括/, "").replace(/等$/, ""));
        }
        continue;
      }
      if (label.endsWith("相关问题处理") && classifyWork(item) === broadCat) {
        const d = getItemDetails(item);
        if (d) absorbedDetails.push(d.replace(/^：包括/, "").replace(/等$/, ""));
        continue;
      }
      filtered.push(item);
    }
    if (broadItem) {
      if (absorbedDetails.length > 0) {
        const existingDetails = getItemDetails(broadItem);
        const existingContent = existingDetails ? existingDetails.replace(/^：包括/, "").replace(/等$/, "") : "";
        const allContent = [...absorbedDetails, existingContent].filter(d => d).join("、");
        broadItem = allContent ? `${broadLabel}：包括${allContent}等` : broadLabel;
      }
      filtered.push(broadItem);
    }
    result = filtered;
  }
  return result;
}

// Unified simplification for both personnel and project summaries
// keepDetails=true (personnel): keep "XX：包括A、B等" format
// keepDetails=false (project): strip to just category label
function simplifySummary(items, keepDetails = false) {
  // Strip or keep detailed lists
  let simplified = items.map(item => {
    if (item.includes("：包括")) {
      if (keepDetails) return item;
      return getItemLabel(item);
    }
    return item;
  });
  // Process main labels: merge problem/other categories into "运维及其他工作"
  // Always rename broad categories even when preserving details
  simplified = simplified.map(item => {
    const label = getItemLabel(item);
    const details = getItemDetails(item);
    if (label === "问题处理相关工作" || label === "其他运维相关工作" ||
        label === "其他相关工作" || label === "运维及其他相关工作") {
      return "运维及其他工作" + details;
    }
    if (keepDetails && details) return item;
    return item;
  });
  // Rename "XX相关工作" → "XX相关问题处理" (except "运维及其他工作")
  // Skip for items with details when keepDetails=true
  simplified = simplified.map(item => {
    const label = getItemLabel(item);
    const details = getItemDetails(item);
    if (label === "运维及其他工作") return item;
    if (keepDetails && details) return item;
    if (label.endsWith("相关工作")) {
      return label.replace(/相关工作$/, "相关问题处理") + details;
    }
    return item;
  });
  // Clean up "问题" redundancy in main label
  // Skip for items with details when keepDetails=true
  simplified = simplified.map(item => {
    const label = getItemLabel(item);
    const details = getItemDetails(item);
    if (label === "运维及其他工作") return item;
    if (keepDetails && details) return item;
    if (label.endsWith("相关问题处理")) {
      const prefix = label.slice(0, -6);
      if (prefix.endsWith("问题")) {
        return prefix.slice(0, -2) + "相关问题处理" + details;
      }
    }
    return item;
  });
  // Merge "生产环境" and "生产运维" into "运维"
  const prodGroups = simplified.filter(item => {
    const label = getItemLabel(item);
    return label === "生产环境相关问题处理" || label === "生产运维相关问题处理";
  });
  if (prodGroups.length >= 2) {
    const others = simplified.filter(item => !prodGroups.includes(item));
    const allDetails = prodGroups.map(getItemDetails).filter(d => d);
    if (allDetails.length > 0) {
      const content = allDetails.map(d => d.replace(/^：包括/, "").replace(/等$/, "")).join("、");
      others.push(`运维相关问题处理：包括${content}等`);
    } else {
      others.push("运维相关问题处理");
    }
    simplified = others;
  }
  // Merge related thematic groups
  simplified = mergeRelatedGroups(simplified);
  // Merge sub-categories into broader catch-all categories (e.g., 运维相关问题处理 → 运维及其他工作)
  simplified = mergeSubCategories(simplified);
  // Dedup and move "运维及其他工作" to end
  const deduped = [...new Set(simplified)];
  const finalItems = [];
  let otherItem = null;
  for (const item of deduped) {
    const label = getItemLabel(item);
    if (label === "运维及其他工作") {
      if (otherItem === null) {
        otherItem = item;
      } else {
        // Merge details from duplicate "运维及其他工作" items
        const d1 = getItemDetails(otherItem).replace(/^：包括/, "").replace(/等$/, "");
        const d2 = getItemDetails(item).replace(/^：包括/, "").replace(/等$/, "");
        const combined = [d1, d2].filter(d => d).join("、");
        otherItem = combined ? `运维及其他工作：包括${combined}等` : "运维及其他工作";
      }
    } else {
      finalItems.push(item);
    }
  }
  if (otherItem !== null) finalItems.push(otherItem);
  return finalItems;
}

// Drop secondary/setup tasks (部署环境、熟悉需求、初始化等) when items > 8
const secondaryTaskPatterns = [/部署/, /熟悉/, /环境搭建/, /初始化/, /提交脚本/, /端口梳理/, /网络情况/];
function dropSecondaryTasks(items) {
  if (items.length <= 8) return items;
  const filtered = items.filter(item => {
    if (item.includes("相关问题处理") || getItemLabel(item) === "运维及其他工作") return true;
    if (item.includes("相关工作")) return true;
    if (item === "编写说明文档" || item === "操作指引沟通") return true;
    if (secondaryTaskPatterns.some(p => p.test(item))) return false;
    return true;
  });
  return filtered.length >= 3 ? filtered : items;
}

// Filter trivial tasks (just submitting scripts/code) - always applied
const trivialTaskPatterns = [/^提交(脚本|代码)/];
function filterTrivialTasks(items) {
  return items.filter(item => {
    const label = getItemLabel(item);
    return !trivialTaskPatterns.some(p => p.test(label));
  });
}

// Build project-based summary from personnel summary output
// Ensures project summary is a STRICT SUBSET of personnel summary
function buildProjectSummary() {
  const projItemsMap = {};   // projName -> [{ text, person }]
  const projItemPersons = {}; // projName -> { text -> Set(persons) }

  for (const ps of workSummaries) {
    for (const pd of ps.projects) {
      const projName = pd.name;
      if (!projItemsMap[projName]) { projItemsMap[projName] = []; projItemPersons[projName] = {}; }
      for (const item of pd.items) {
        let text = item.replace(/^\d+\.\s*/, "");
        const parts = text.split("；");
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) {
            projItemsMap[projName].push({ text: trimmed, person: ps.person });
            if (!projItemPersons[projName][trimmed]) projItemPersons[projName][trimmed] = new Set();
            projItemPersons[projName][trimmed].add(ps.person);
          }
        }
      }
    }
  }

  const result = [];
  for (const proj of sortedProjects) {
    const cleanProj = cleanName(proj);
    const records = projItemsMap[cleanProj] || [];
    const itemPersons = projItemPersons[cleanProj] || {};

    // Unique items with person frequency, filter trivial tasks
    const uniqueItems = filterTrivialTasks([...new Set(records.map(r => r.text))]);

    // Smart merge pipeline
    let items = mergeByPrefix(uniqueItems);
    items = mergeByCategory(items);
    items = mergeSimilarItems(items);
    items = groupThemes(items);
    items = simplifySummary(items);
    items = dropSecondaryTasks(items);

    // If still many, drop single-person minor tasks (keep thematic groups and category labels)
    const categoryLabels = ["编写说明文档", "操作指引沟通"];
    if (items.length > 8) {
      const filtered = items.filter(item => {
        if (item.includes("相关问题处理") || getItemLabel(item) === "运维及其他工作") return true;
        if (item.includes("相关工作")) return true;
        if (categoryLabels.includes(item)) return true;
        // Check if any source item (or similar) was mentioned by 2+ persons
        for (const [orig, persons] of Object.entries(itemPersons)) {
          if (item === orig || item.includes(orig) || orig.includes(item) || charJaccard(item, orig) >= 0.7) {
            if (persons.size > 1) return true;
          }
        }
        return false;
      });
      if (filtered.length >= 3) items = filtered;
    }

    // Sort by category, thematic groups first within each category
    items = sortByCategory(items);

    result.push({
      name: cleanProj,
      hours: projHours[proj],
      peopleCount: projPeople[proj].size,
      people: Array.from(projPeople[proj]).sort().map(p => cleanPerson(p)).join("、"),
      items: items.map((item, i) => `${i + 1}. ${item}`)
    });
  }
  return result;
}

// ============ Build Document ============
const workSummaries = buildPersonSummary();
const projectSummaries = buildProjectSummary();

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: FONT, size: 21 },
        paragraph: { spacing: { before: 60, after: 60 } },
      },
    },
  },
  sections: [
    // Cover page
    {
      properties: {},
      children: [
        new Paragraph({ spacing: { before: 3000 } }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 300 },
          children: [
            new TextRun({ text: startMo !== endMo ? `项目月报` : `项目月报（${startYr}年${startMo}月）`, font: FONT, size: 52, bold: true, color: "1a1a1a" }),
          ],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 100, after: 600 },
          children: [
            new TextRun({ text: `${formatDate(startDateStr)} - ${formatDate(endDateStr)}`, font: FONT, size: 28, color: "666666" }),
          ],
        }),
        // Summary table
        new Table({
          alignment: AlignmentType.CENTER,
          width: { size: 6000, type: WidthType.DXA },
          rows: [
            makeRow([headerCell("指标", { width: 2000 }), headerCell("数值", { width: 4000 })]),
            makeRow([cell("填报记录数", { width: 2000 }), cell(`${totalRecords} 条`, { width: 4000 })]),
            makeRow([cell("总工时", { width: 2000 }), cell(`${totalHours} 小时`, { width: 4000 })]),
            makeRow([cell("总人天", { width: 2000 }), cell(`${personDaysTotal} 人天`, { width: 4000 })]),
            makeRow([cell("工作日数", { width: 2000 }), cell(`${uniqueDays} 天`, { width: 4000 })]),
            makeRow([cell("参与人数", { width: 2000 }), cell(`${personCount} 人`, { width: 4000 })]),
            makeRow([cell("涉及项目数", { width: 2000 }), cell(`${projectCount} 个`, { width: 4000 })]),
          ],
        }),
        new Paragraph({ children: [new PageBreak()] }),
      ],
    },
    // Main content
    {
      properties: {
        page: {
          size: {
            orientation: PageOrientation.LANDSCAPE,
            width: 16838,
            height: 11906,
          },
          margin: { top: 720, right: 720, bottom: 720, left: 720 },
        },
      },
      children: [
        // Section 1: Person overview
        heading("一、人员投入统计"),
        new Table({
          alignment: AlignmentType.CENTER,
          width: { size: 9000, type: WidthType.DXA },
          rows: [
            makeRow([
              headerCell("人员", { width: 2000 }),
              headerCell("投入工时（人天）", { width: 2000 }),
              headerCell("填报天数", { width: 1500 }),
              headerCell("参与项目", { width: 3500 }),
            ]),
            ...sortedPersons.map(person => {
              const projects = Array.from(personProjects[person]).sort();
              return makeRow([
                cell(person, { width: 2000 }),
                cell(`${personHours[person]}（${pdStr(personHours[person])}）`, { width: 2000 }),
                cell(`${personDays[person].size}`, { width: 1500 }),
                cell(projects.map(n => cleanName(n)).join("、"), { width: 3500, alignment: AlignmentType.LEFT }),
              ]);
            }),
            makeRow([
              cell("合计", { width: 2000, bold: true, shading: "F0F0F0" }),
              cell(`${totalHours}（${pdStr(totalHours)}）`, { width: 2000, bold: true, shading: "F0F0F0" }),
              cell("-", { width: 1500, shading: "F0F0F0" }),
              cell("-", { width: 3500, shading: "F0F0F0" }),
            ]),
          ],
        }),

        // Section 2: Project overview
        heading("二、项目投入统计"),
        new Table({
          alignment: AlignmentType.CENTER,
          width: { size: 9000, type: WidthType.DXA },
          rows: [
            makeRow([
              headerCell("项目", { width: 2500 }),
              headerCell("投入工时（人天）", { width: 2000 }),
              headerCell("参与人数", { width: 1500 }),
              headerCell("参与人员", { width: 3000 }),
            ]),
            ...sortedProjects.map(proj => {
              const people = Array.from(projPeople[proj]).sort();
              return makeRow([
                cell(cleanName(proj), { width: 2500, alignment: AlignmentType.LEFT }),
                cell(`${projHours[proj]}（${pdStr(projHours[proj])}）`, { width: 2000 }),
                cell(`${projPeople[proj].size}`, { width: 1500 }),
                cell(people.map(p => cleanPerson(p)).join("、"), { width: 3000, alignment: AlignmentType.LEFT }),
              ]);
            }),
            makeRow([
              cell("合计", { width: 2500, bold: true, shading: "F0F0F0" }),
              cell(`${totalHours}（${pdStr(totalHours)}）`, { width: 2000, bold: true, shading: "F0F0F0" }),
              cell("-", { width: 1500, shading: "F0F0F0" }),
              cell("-", { width: 3000, shading: "F0F0F0" }),
            ]),
          ],
        }),

        // Section 3: Person-Project matrix - use PERCENTAGE width to avoid compression
        heading("三、人员×项目投入矩阵（工时）"),
        (() => {
          const namePct = 14;       // 14% for person name column (wider to fit "后端 马少平" without wrapping)
          const totalPct = 8;       // 8% for total column
          const projPct = Math.floor((100 - namePct - totalPct) / sortedProjects.length); // remaining split equally
          return new Table({
            alignment: AlignmentType.CENTER,
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              makeRow([
                headerCell("人员", { widthPct: namePct }),
                ...sortedProjects.map(proj => headerCell(cleanName(proj), { widthPct: projPct })),
                headerCell("合计", { widthPct: totalPct }),
              ]),
              ...sortedPersons.map(person => {
                const rowCells = [cell(person, { widthPct: namePct })];
                let rowTotal = 0;
                for (const proj of sortedProjects) {
                  const hrs = personProjHours[person]?.[proj] || 0;
                  rowTotal += hrs;
                  rowCells.push(cell(hrs > 0 ? `${hrs}` : "-", { widthPct: projPct }));
                }
                rowCells.push(cell(`${rowTotal}`, { widthPct: totalPct, bold: true }));
                return makeRow(rowCells);
              }),
              // Total row
              makeRow([
                cell("合计", { widthPct: namePct, bold: true, shading: "F0F0F0" }),
                ...sortedProjects.map(proj => cell(`${projHours[proj]}`, { widthPct: projPct, bold: true, shading: "F0F0F0" })),
                cell(`${totalHours}`, { widthPct: totalPct, bold: true, shading: "F0F0F0" }),
              ]),
            ],
          });
        })(),

        // Section 4: Work summary by person
        heading("四、人员月度工作总结"),
        ...workSummaries.flatMap(({ person, totalHours, days, projects }) => {
          const paras = [
            new Paragraph({
              spacing: { before: 80, after: 20 },
              children: [new TextRun({ text: `${person}  ${totalHours}工时（合计${pdStr(totalHours)}人天），总共填报${days}次`, font: FONT, size: 22, color: "0066CC", bold: true })],
            }),
          ];
          for (const { name, hours, days: pdays, items } of projects) {
            paras.push(new Paragraph({
              spacing: { before: 40, after: 20 },
              indent: { left: 120 },
              children: [new TextRun({ text: `${name}  ${hours}工时（合计${pdStr(hours)}人天），填报${pdays}次`, font: FONT, size: 21, bold: true })],
            }));
            for (const item of items) {
              paras.push(new Paragraph({
                spacing: { before: 20, after: 20 },
                indent: { left: 480 },
                children: [new TextRun({ text: item, font: FONT, size: 21 })],
              }));
            }
          }
          return paras;
        }),

        // Section 5: Work summary by project
        heading("五、项目月度工作总结"),
        ...projectSummaries.flatMap(({ name, hours, peopleCount, people, items }) => {
          const paras = [
            new Paragraph({
              spacing: { before: 80, after: 20 },
              children: [new TextRun({ text: `${name}  ${hours}工时（合计${pdStr(hours)}人天），${peopleCount}人参与（${people}）`, font: FONT, size: 22, bold: true })],
            }),
          ];
          for (const item of items) {
            paras.push(new Paragraph({
              spacing: { before: 20, after: 20 },
              indent: { left: 480 },
              children: [new TextRun({ text: item, font: FONT, size: 21 })],
            }));
          }
          return paras;
        }),
      ],
    },
  ],
});

// ============ Generate ============
const OUT = `D:\\华为家庭存储\\工作文档\\TIU管理\\周报月报\\monthly-report-${rangeStart}-to-${rangeEnd}.docx`;

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUT, buffer);
  console.log(`Generated: ${OUT}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB`);
});
