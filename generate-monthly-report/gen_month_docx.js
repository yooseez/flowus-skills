const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, HeadingLevel, PageBreak,
  ShadingType, TableLayoutType, VerticalAlign, convertInchesToTwip,
  PageOrientation
} = require("docx");

// Load data - filter by target month and exclude unknown persons (0h records)
// Usage: node gen_month_docx.js <YYYY-MM> [input.json]
// Example: node gen_month_docx.js 2026-06 june_data.json
const args = process.argv.slice(2);
const targetMonth = args[0] || "2026-06"; // default: June 2026
const inputFile = args[1] || "c:\\Users\\HONOR\\.trae-cn\\work\\6a5dc6c8f3dd409051bb8edc\\june_data.json";
const [targetYr, targetMo] = targetMonth.split("-").map(Number);

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
  // Strict natural month filter
  return r.yr === targetYr && r.mo === targetMo;
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
const monthLabel = `${targetYr}年${targetMo}月`;

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
function mergeSimilarItems(items) {
  const unique = [...new Set(items)].filter(t => t && t.trim());
  const sorted = unique.sort((a, b) => a.length - b.length);
  const merged = [];
  for (const item of sorted) {
    const isSimilar = merged.some(m => {
      if (m.includes(item) || item.includes(m)) return true;
      let commonLen = 0;
      for (let i = 0; i < Math.min(item.length, m.length); i++) {
        if (item[i] === m[i]) commonLen++;
        else break;
      }
      if (commonLen >= 5) return true;
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

// Group thematically related items: when 3+ items share a common prefix (>=2 chars),
// merge ALL into one summary. If more than 5 items, list the 5 shortest.
function groupThemes(items) {
  if (items.length < 3) return items;

  const used = new Set();
  const result = [];

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    const groupIndices = [i];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
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

        result.push(`${displayName}相关工作，包括${itemsToList.join("、")}等`);
        groupIndices.forEach(idx => used.add(idx));
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    if (!used.has(i)) result.push(items[i]);
  }

  return result;
}

// Format work items: series/long items on own numbered lines, fragmented items grouped
// "其他相关" items sorted to appear last
function formatWorkItems(items) {
  items = items.map(item => item.replace(/处理相关问题/g, "处理其他问题"));
  const standalone = [];
  const fragmented = [];
  const otherItems = [];
  for (const item of items) {
    if (/其他.*相关/.test(item)) {
      otherItems.push(item);
    } else if (item.includes("相关") || item.length > 15) {
      standalone.push(item);
    } else {
      fragmented.push(item);
    }
  }
  const result = [];
  let num = 1;
  for (const item of standalone) {
    result.push(`${num++}. ${item}`);
  }
  if (fragmented.length > 0) {
    result.push(`${num++}. ${fragmented.join("；")}`);
  }
  for (const item of otherItems) {
    result.push(`${num++}. ${item}`);
  }
  return result;
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
        // progress-N corresponds to projects[N-1] by index
        for (let i = 0; i < r.projects.length; i++) {
          const p = r.projects[i];
          if (p.project === proj) {
            days.add(r.date);
            if (p.task) tasks.add(p.task);
            // Only use the matching progress for this project slot
            const progressKey = `progress${i + 1}`;
            const progressText = r[progressKey];
            if (progressText) {
              progresses.push(progressText);
            }
          }
        }
      }

      // Step 1: Try to extract meaningful work from progress notes
      const mainWork = [];
      const seen = new Set();
      for (const prog of progresses) {
        const lines = prog.split("\n").filter(l => l.trim());
        for (const line of lines) {
          const cleaned = line.trim().replace(/^\d+[、.．]\s*/, "");
          if (isProgressMeaningful(cleaned) && cleaned.length < 50 && !seen.has(cleaned)) {
            seen.add(cleaned);
            mainWork.push(cleaned);
          }
        }
      }

      // Step 2: If progress notes are too short, combine with task names for context
      if (mainWork.length > 0 && tasks.size > 0) {
        const taskArr = [...tasks];
        for (let i = 0; i < mainWork.length; i++) {
          if (mainWork[i].length < 6) {
            mainWork[i] = `${taskArr[0]}：${mainWork[i]}`;
          }
        }
      }

      // Step 3: If no progress notes at all, fall back to task names
      if (mainWork.length === 0 && tasks.size > 0) {
        mainWork.push(...tasks);
      }

      // Step 3: Merge similar items (dedup reordered/similar text)
      const merged = mergeSimilarItems(mainWork);
      // Step 4: Group thematically related items for readability
      const grouped = groupThemes(merged);
      // Step 5: Format with numbering (series standalone, fragmented grouped)
      const items = formatWorkItems(grouped.slice(0, 8));

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

// ============ Build Document ============
const workSummaries = buildPersonSummary();

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
            new TextRun({ text: `项目月报（${monthLabel}）`, font: FONT, size: 52, bold: true, color: "1a1a1a" }),
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
                cell(`${personHours[person]}（${(personHours[person] / 8).toFixed(1)}）`, { width: 2000 }),
                cell(`${personDays[person].size}`, { width: 1500 }),
                cell(projects.map(n => cleanName(n)).join("、"), { width: 3500, alignment: AlignmentType.LEFT }),
              ]);
            }),
            makeRow([
              cell("合计", { width: 2000, bold: true, shading: "F0F0F0" }),
              cell(`${totalHours}（${(totalHours / 8).toFixed(1)}）`, { width: 2000, bold: true, shading: "F0F0F0" }),
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
                cell(`${projHours[proj]}（${(projHours[proj] / 8).toFixed(1)}）`, { width: 2000 }),
                cell(`${projPeople[proj].size}`, { width: 1500 }),
                cell(people.map(p => cleanPerson(p)).join("、"), { width: 3000, alignment: AlignmentType.LEFT }),
              ]);
            }),
            makeRow([
              cell("合计", { width: 2500, bold: true, shading: "F0F0F0" }),
              cell(`${totalHours}（${(totalHours / 8).toFixed(1)}）`, { width: 2000, bold: true, shading: "F0F0F0" }),
              cell("-", { width: 1500, shading: "F0F0F0" }),
              cell("-", { width: 3000, shading: "F0F0F0" }),
            ]),
          ],
        }),

        // Section 3: Person-Project matrix - use PERCENTAGE width to avoid compression
        heading("三、人员×项目投入矩阵（h）"),
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

        // Section 4: Monthly work summary per person
        heading("四、月度工作总结"),
        ...workSummaries.flatMap(({ person, totalHours, days, projects }) => {
          const paras = [
            new Paragraph({
              spacing: { before: 80, after: 20 },
              children: [new TextRun({ text: `${person}（${totalHours}h，参与${days}天）：`, font: FONT, size: 22, color: "0066CC", bold: true })],
            }),
          ];
          for (const { name, hours, days: pdays, items } of projects) {
            paras.push(new Paragraph({
              spacing: { before: 40, after: 20 },
              indent: { left: 120 },
              children: [new TextRun({ text: `${name}（${hours}h，参与${pdays}天）`, font: FONT, size: 21, bold: true })],
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
      ],
    },
  ],
});

// ============ Generate ============
const OUT = `D:\\华为家庭存储\\工作文档\\TIU管理\\周报月报\\monthly-report-${targetMonth}.docx`;

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUT, buffer);
  console.log(`Generated: ${OUT}`);
  console.log(`Size: ${(buffer.length / 1024).toFixed(1)} KB`);
});
